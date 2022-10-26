# Generated by Django 2.2.28 on 2022-07-29 16:19
# type:ignore
from django.db import migrations

import sentry.db.models.fields.bounded
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

    # This flag is used to decide whether to run this migration in a transaction or not. Generally
    # we don't want to run in a transaction here, since for long running operations like data
    # back-fills this results in us locking an increasing number of rows until we finally commit.
    atomic = False

    dependencies = [
        ("replays", "0001_init_replays"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            state_operations=[
                migrations.RenameField(
                    model_name="replayrecordingsegment",
                    old_name="sequence_id",
                    new_name="segment_id",
                ),
                migrations.AlterField(
                    model_name="replayrecordingsegment",
                    name="segment_id",
                    field=sentry.db.models.fields.bounded.BoundedIntegerField(
                        db_column="sequence_id"
                    ),
                ),
                migrations.AlterUniqueTogether(
                    name="replayrecordingsegment",
                    unique_together={
                        ("project_id", "replay_id", "file_id"),
                        ("project_id", "replay_id", "segment_id"),
                    },
                ),
                migrations.AlterIndexTogether(
                    name="replayrecordingsegment",
                    index_together={("replay_id", "segment_id")},
                ),
            ]
        )
    ]
