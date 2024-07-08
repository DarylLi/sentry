from datetime import datetime, timedelta, timezone

import pytest
from snuba_sdk import AliasedExpression, And, Column, Condition, Function, Op

from sentry.search.events.builder.spans_indexed import SpansIndexedQueryBuilder
from sentry.snuba.dataset import Dataset
from sentry.testutils.factories import Factories
from sentry.testutils.pytest.fixtures import django_db_all


@pytest.fixture
def now():
    return datetime(2022, 10, 31, 0, 0, tzinfo=timezone.utc)


@pytest.fixture
def today(now):
    return now.replace(hour=0, minute=0, second=0, microsecond=0)


@pytest.fixture
def params(now, today):
    organization = Factories.create_organization()
    team = Factories.create_team(organization=organization)
    project1 = Factories.create_project(organization=organization, teams=[team])
    project2 = Factories.create_project(organization=organization, teams=[team])

    user = Factories.create_user()
    Factories.create_team_membership(team=team, user=user)

    return {
        "start": now - timedelta(days=7),
        "end": now - timedelta(seconds=1),
        "project_id": [project1.id, project2.id],
        "project_objects": [project1, project2],
        "organization_id": organization.id,
        "user_id": user.id,
        "team_id": [team.id],
    }


span_duration = Function(
    "if",
    [
        Function("greater", [Column("exclusive_time"), Column("duration")]),
        Column("exclusive_time"),
        Column("duration"),
    ],
    "span.duration",
)


@pytest.mark.parametrize(
    ["field", "expected"],
    [
        pytest.param("span.duration", span_duration, id="span.duration"),
        pytest.param(
            "profile.id",
            AliasedExpression(Column("profile_id"), alias="profile.id"),
            id="profile.id",
        ),
    ],
)
@django_db_all
def test_field_alias(params, field, expected):
    builder = SpansIndexedQueryBuilder(
        Dataset.SpansIndexed,
        params,
        selected_columns=[field],
    )
    assert expected in builder.columns


def tags(key, column="tags"):
    return Function("ifNull", [Column(f"{column}[{key}]"), ""])


def has_tag(key, column="tags"):
    return Condition(Function("has", [Column("tags.key"), key]), Op.EQ, 1)


@pytest.mark.parametrize(
    ["condition", "expected"],
    [
        pytest.param(
            "span.duration:1s",
            Condition(span_duration, Op.EQ, 1000),
            id="span.duration:1s",
            marks=pytest.mark.querybuilder,
        ),
        pytest.param(
            "span.duration:>1s", Condition(span_duration, Op.GT, 1000), id="span.duration:>1s"
        ),
        pytest.param(
            "span.duration:<1s", Condition(span_duration, Op.LT, 1000), id="span.duration:<1s"
        ),
        pytest.param(
            "span.duration:>=1s", Condition(span_duration, Op.GTE, 1000), id="span.duration:>=1s"
        ),
        pytest.param(
            "span.duration:<=1s", Condition(span_duration, Op.LTE, 1000), id="span.duration:<=1s"
        ),
        pytest.param(
            "span.duration:<=1s", Condition(span_duration, Op.LTE, 1000), id="span.duration:<=1s"
        ),
        pytest.param(
            "span.op:db",
            Condition(Column("op"), Op.EQ, "db"),
            id="span.op:db",
        ),
        pytest.param(
            "span.op:[db,http.client]",
            Condition(Column("op"), Op.IN, ["db", "http.client"]),
            id="span.op:[db,http.client]",
        ),
        pytest.param(
            "span.status:ok",
            Condition(Column("span_status"), Op.EQ, 0),
            id="span.status:ok",
        ),
        pytest.param(
            "span.status:[invalid_argument,not_found]",
            Condition(Column("span_status"), Op.IN, [3, 5]),
            id="span.status:[invalid_argument,not_found]",
        ),
        pytest.param(
            "foo:*bar*",
            And(
                conditions=[
                    Condition(Function("positionCaseInsensitive", [tags("foo"), "bar"]), Op.NEQ, 0),
                    has_tag("foo"),
                ],
            ),
            id="foo:*bar*",
        ),
        pytest.param(
            "!foo:*bar*",
            And(
                conditions=[
                    Condition(Function("positionCaseInsensitive", [tags("foo"), "bar"]), Op.EQ, 0),
                    has_tag("foo"),
                ],
            ),
            id="!foo:*bar*",
        ),
        pytest.param(
            r"foo:Bar*",
            And(
                conditions=[
                    Condition(
                        Function("startsWith", [Function("lower", [tags("foo")]), "bar"]), Op.EQ, 1
                    ),
                    has_tag("foo"),
                ],
            ),
            id=r"foo:Bar*",
        ),
        pytest.param(
            r"!foo:Bar*",
            And(
                conditions=[
                    Condition(
                        Function("startsWith", [Function("lower", [tags("foo")]), "bar"]), Op.NEQ, 1
                    ),
                    has_tag("foo"),
                ],
            ),
            id=r"!foo:Bar*",
        ),
        pytest.param(
            r"foo:*Bar",
            And(
                conditions=[
                    Condition(
                        Function("endsWith", [Function("lower", [tags("foo")]), "bar"]), Op.EQ, 1
                    ),
                    has_tag("foo"),
                ],
            ),
            id=r"foo:*Bar",
        ),
        pytest.param(
            r"!foo:*Bar",
            And(
                conditions=[
                    Condition(
                        Function("endsWith", [Function("lower", [tags("foo")]), "bar"]), Op.NEQ, 1
                    ),
                    has_tag("foo"),
                ],
            ),
            id=r"!foo:*Bar",
        ),
        pytest.param(
            r"foo:*Bar\*",
            And(
                conditions=[
                    Condition(
                        Function("endsWith", [Function("lower", [tags("foo")]), "bar*"]), Op.EQ, 1
                    ),
                    has_tag("foo"),
                ],
            ),
            id=r"foo:*Bar\*",
        ),
        pytest.param(
            r"!foo:*Bar\*",
            And(
                conditions=[
                    Condition(
                        Function("endsWith", [Function("lower", [tags("foo")]), "bar*"]), Op.NEQ, 1
                    ),
                    has_tag("foo"),
                ],
            ),
            id=r"!foo:*Bar\*",
        ),
        pytest.param(
            r"foo:*b*a*r*",
            And(
                conditions=[
                    Condition(Function("match", [tags("foo"), "(?i)^.*b.*a.*r.*$"]), Op.EQ, 1),
                    has_tag("foo"),
                ],
            ),
            id=r"foo:*b*a*r*",
        ),
        pytest.param(
            r"!foo:*b*a*r*",
            And(
                conditions=[
                    Condition(Function("match", [tags("foo"), "(?i)^.*b.*a.*r.*$"]), Op.NEQ, 1),
                    has_tag("foo"),
                ],
            ),
            id=r"!foo:*b*a*r*",
        ),
        pytest.param(
            "message:*bar*",
            Condition(
                Function("positionCaseInsensitive", [Column("description"), "bar"]), Op.NEQ, 0
            ),
            id="message:*bar*",
        ),
        pytest.param(
            "!message:*bar*",
            Condition(
                Function("positionCaseInsensitive", [Column("description"), "bar"]), Op.EQ, 0
            ),
            id="!message:*bar*",
        ),
        pytest.param(
            r"message:Bar*",
            Condition(
                Function("startsWith", [Function("lower", [Column("description")]), "bar"]),
                Op.EQ,
                1,
            ),
            id=r"message:Bar*",
        ),
        pytest.param(
            r"!message:Bar*",
            Condition(
                Function("startsWith", [Function("lower", [Column("description")]), "bar"]),
                Op.NEQ,
                1,
            ),
            id=r"!message:Bar*",
        ),
        pytest.param(
            r"message:*Bar",
            Condition(
                Function("endsWith", [Function("lower", [Column("description")]), "bar"]), Op.EQ, 1
            ),
            id=r"message:*Bar",
        ),
        pytest.param(
            r"!message:*Bar",
            Condition(
                Function("endsWith", [Function("lower", [Column("description")]), "bar"]), Op.NEQ, 1
            ),
            id=r"!message:*Bar",
        ),
        pytest.param(
            r"message:*Bar\*",
            Condition(
                Function("endsWith", [Function("lower", [Column("description")]), "bar*"]), Op.EQ, 1
            ),
            id=r"message:*Bar\*",
        ),
        pytest.param(
            r"!message:*Bar\*",
            Condition(
                Function("endsWith", [Function("lower", [Column("description")]), "bar*"]),
                Op.NEQ,
                1,
            ),
            id=r"!message:*Bar\*",
        ),
        pytest.param(
            r"message:*b*a*r*",
            Condition(Function("match", [Column("description"), "(?i).*b.*a.*r.*"]), Op.EQ, 1),
            id=r"message:*b*a*r*",
        ),
        pytest.param(
            r"!message:*b*a*r*",
            Condition(Function("match", [Column("description"), "(?i).*b.*a.*r.*"]), Op.NEQ, 1),
            id=r"!message:*b*a*r*",
        ),
    ],
)
@django_db_all
def test_where(params, condition, expected):
    builder = SpansIndexedQueryBuilder(
        Dataset.SpansIndexed,
        params,
        query=condition,
        selected_columns=["count"],
    )
    assert expected in builder.where


@django_db_all
def test_where_project(params):
    project = next(iter(params["project_objects"]))

    for query in [f"project:{project.slug}", f"project.id:{project.id}"]:
        builder = SpansIndexedQueryBuilder(
            Dataset.SpansIndexed,
            params,
            query=query,
            selected_columns=["count"],
        )

        assert Condition(Column("project_id"), Op.EQ, project.id) in builder.where


@pytest.mark.parametrize(
    ["query", "expected"],
    [
        pytest.param(
            "span.op:params test",
            Condition(
                Function("positionCaseInsensitive", [Column("description"), "test"]),
                Op.NEQ,
                0,
            ),
            id="span.op:params test",
        ),
        pytest.param(
            "testing",
            Condition(
                Function("positionCaseInsensitive", [Column("description"), "testing"]),
                Op.NEQ,
                0,
            ),
            id="testing",
        ),
        pytest.param(
            "span.description:test1 test2",
            Condition(
                Function("positionCaseInsensitive", [Column("description"), "test2"]),
                Op.NEQ,
                0,
            ),
            id="span.description:test1 test2",
        ),
        pytest.param(
            "*testing*",
            Condition(
                Function("positionCaseInsensitive", [Column("description"), "testing"]),
                Op.NEQ,
                0,
            ),
            id="*testing*",
        ),
        pytest.param(
            "*test*ing*",
            Condition(
                Function("match", [Column("description"), "(?i).*test.*ing.*"]),
                Op.EQ,
                1,
            ),
            id="*test*ing*",
        ),
    ],
)
@django_db_all
def test_free_text_search(params, query, expected):
    builder = SpansIndexedQueryBuilder(
        Dataset.SpansIndexed,
        params,
        query=query,
        selected_columns=["count"],
    )
    assert expected in builder.where
