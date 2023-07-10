# Generated by Django 2.2.28 on 2023-06-27 17:01

from django.db import migrations

import bitfield.models
from sentry.new_migrations.migrations import CheckedMigration


class Migration(CheckedMigration):
    # This flag is used to mark that a migration shouldn't be automatically run in production. For
    # the most part, this should only be used for operations where it's safe to run the migration
    # after your code has deployed. So this should not be used for most operations that alter the
    # schema of a table.
    # Here are some things that make sense to mark as dangerous:
    # - Large data migrations. Typically we want these to be run manually by ops so that they can
    #   be monitored and not block the deploy for a long period of time while they run.
    # - Adding indexes to large tables. Since this can take a long time, we'd generally prefer to
    #   have ops run this and not block the deploy. Note that while adding an index is a schema
    #   change, it's completely safe to run the operation after the code has deployed.
    is_dangerous = False

    dependencies = [
        ("sentry", "0497_add_comment_reactions_column"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[],
            state_operations=[
                migrations.AlterField(
                    model_name="project",
                    name="flags",
                    field=bitfield.models.BitField(
                        [
                            "has_releases",
                            "has_issue_alerts_targeting",
                            "has_transactions",
                            "has_alert_filters",
                            "has_sessions",
                            "has_profiles",
                            "has_replays",
                            "spike_protection_error_currently_active",
                            "spike_protection_transaction_currently_active",
                            "spike_protection_attachment_currently_active",
                            "has_minified_stack_trace",
                            "has_cron_monitors",
                            "has_cron_checkins",
                        ],
                        default=10,
                        null=True,
                    ),
                ),
                migrations.AlterField(
                    model_name="projectkey",
                    name="roles",
                    field=bitfield.models.BitField(["store", "api"], default=1, null=None),
                ),
            ],
        )
    ]
