import logging

import openai
from django.conf import settings
from django.http import HttpResponse

from sentry import eventstore, features
from sentry.api.base import region_silo_endpoint
from sentry.api.bases.project import ProjectEndpoint
from sentry.api.exceptions import ResourceDoesNotExist
from sentry.utils import json

logger = logging.getLogger(__name__)


from rest_framework.request import Request
from rest_framework.response import Response

# this is pretty ugly
openai.api_key = settings.OPENAI_API_KEY

PROMPT = """\
This assistent analyses software errors

* The stack trace is shown with most recent call last
* The faulting stack frame lines are marked with a leading `>`
* Surrounding source context is marked with a leading `|`
* Analyze all parts of the error for mentions of a query or user input
* When summarizing the issue:
  * Establish context where the issue is located
  * Briefly explain the error and message
  * Briefly explain if this is likely a regression or an intermittent issue
* When describing the problem in detail:
  * try to analyze if this is a code regression or intermittent issue
  * try to analyze if the issue is in a third party library or user code
  * try to understand if this issue is caused by external factors (networking issues etc.) or a bug
  * If the problem has user input, include a summary of the input
  * If the problem mentions a query, include a summary of the query
* When suggesting a fix:
  * Explain where the fix should be located
  * Explain in detail what code changes are necessary

Write the answers into the following template:

```
## Summary

[summary of the problem]

## Detailed Description

[long form detailed description of the problem]

## Proposed Solution

[suggestion for how to fix this issue]
```
"""


def describe_event_for_ai(event):
    content = []
    content.append("Tags:")
    for tag_key, tag_value in sorted(event["tags"]):
        content.append(f"- {tag_key}: {tag_value}")

    content.append("")
    exc = event["exception"]["values"][0]
    content.append(f"Exception Clas: {exc['type']}")
    content.append(f"Exception Message: {exc['value']}")
    content.append("")

    frames = exc.get("stacktrace", {}).get("frames")
    if frames:
        content.append("Stacktrace:")
        for frame in frames:
            if not frame["in_app"]:
                continue
            content.append(f"- function: {frame['function']}")
            content.append(f"  module: {frame.get('module')}")
            content.append(f"  filename: {frame['filename']}")
            content.append(f"  line: {frame.get('lineno')}")
            content.append("  source:")
            for line in frame.get("pre_context") or ():
                content.append(f"    | {line}")
            content.append(f"    > {frame.get('context_line') or 'N/A'}")
            for line in frame.get("post_context") or ():
                content.append(f"    | {line}")
            content.append("")

    return "\n".join(content)


@region_silo_endpoint
class EventAiSuggestEndpoint(ProjectEndpoint):
    def get(self, request: Request, project, event_id) -> Response:
        """
        Makes AI make suggestions about an event
        ````````````````````````````````````````

        This endpoint returns a JSON response that provides helpful suggestions about how to
        understand or resolve an event.
        """
        event = eventstore.get_event_by_id(project.id, event_id)
        if event is None:
            raise ResourceDoesNotExist

        if not features.has("organizations:ai-suggest", project.organization, actor=request.user):
            raise ResourceDoesNotExist

        event_info = describe_event_for_ai(event.data)

        response = openai.ChatCompletion.create(
            model="gpt-3.5-turbo",
            messages=[
                {"role": "system", "content": PROMPT},
                {
                    "role": "user",
                    "content": event_info,
                },
            ],
        )

        return HttpResponse(
            json.dumps({"suggestion": response["choices"][0]["message"]["content"]}),
            content_type="application/json",
        )
