from sentry.sentry_apps.services.app import RpcSentryApp
from sentry.sentry_apps.services.region_app.model import (
    RpcSentryAppRequest,
    SentryAppRequestFilterArgs,
)
from sentry.sentry_apps.services.region_app.service import RegionAppService
from sentry.utils.sentry_apps import SentryAppWebhookRequestsBuffer


class DatabaseBackedRegionAppService(RegionAppService):
    def get_buffer_requests_for_region(
        self,
        *,
        sentry_app: RpcSentryApp,
        region_name: str,
        filter: SentryAppRequestFilterArgs | None = None,
    ) -> list[RpcSentryAppRequest]:
        buffer = SentryAppWebhookRequestsBuffer(sentry_app)

        event = filter.get("event", None) if filter else None
        errors_only = filter.get("errors_only", False) if filter else False

        return buffer.get_requests(event=event, errors_only=errors_only)
