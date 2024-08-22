from collections.abc import Callable, Generator, Sequence

from sentry.escalation_policies import EscalationPolicy, trigger_escalation_policy
from sentry.eventstore.models import GroupEvent
from sentry.mail.actions import NotifyEmailTarget
from sentry.mail.forms.notify_email import NotifyEmailForm
from sentry.notifications.types import ActionTargetType, FallthroughChoiceType
from sentry.rules.actions.base import EventAction
from sentry.rules.base import CallbackFuture
from sentry.types.rules import RuleFuture

FALLTHROUGH_CHOICES = [
    (FallthroughChoiceType.NO_ONE.value, "No One"),
]

ACTION_CHOICES = [
    (ActionTargetType.POLICY.value, "Escalation Policy"),
]


class NotifyEscalationAction(EventAction):
    """Used for triggering a messages according to escalation policies."""

    id = "sentry.rules.actions.escalation.NotifyEscalationAction"
    label = "Send a notification according to the triage schedule"
    prompt = "Send a notification according to the triage schedule"

    form_cls = NotifyEmailForm

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.form_fields = {
            "targetType": {"type": "escalationAction", "choices": ACTION_CHOICES},
            "fallthroughType": {"type": "choice", "choices": FALLTHROUGH_CHOICES},
        }

    @staticmethod
    def _create_trigger_escalation_callback(
        policy: EscalationPolicy,
    ) -> Callable[[GroupEvent, Sequence[RuleFuture]], None]:
        def callback(event: GroupEvent, futures: Sequence[RuleFuture]) -> None:
            trigger_escalation_policy(policy, event.group)

        return callback

    def after(
        self, event: GroupEvent, notification_uuid: str | None = None
    ) -> Generator[CallbackFuture]:
        target = NotifyEmailTarget.unpack(self)
        # plz figure out the general form for notification targets that can account for
        # dynamic, lazy, targets.
        assert target.target_type == ActionTargetType.POLICY, "OMG REFACTOR THIS LATER"

        # Figure out healthy, secure scoping
        policy = EscalationPolicy.objects.filter(
            organization_id=event.organization.id, id=target.target_identifier
        ).first()

        if policy is None:
            return

        yield self.future(self._create_trigger_escalation_callback(policy))
