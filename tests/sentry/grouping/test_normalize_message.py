from sentry.testutils.cases import TestCase
from sentry.testutils.silo import region_silo_test
from src.sentry.grouping.strategies.message import normalize_message_for_grouping


@region_silo_test
class NormalizeMesageTest(TestCase):
    def test_normalize_message(
        self,
    ) -> None:
        cases = [
            ("email", """blah test@email.com had a problem""", """blah <email> had a problem"""),
            ("url", """blah http://some.email.com had a problem""", """blah <url> had a problem"""),
            (
                "url - existing behavior",
                """blah tcp://user:pass@email.com:10 had a problem""",
                """blah tcp://user:<email>:<int> had a problem""",
            ),
            ("ip", """blah 0.0.0.0 had a problem""", """blah <ip> had a problem"""),
            (
                "UUID",
                """blah 7c1811ed-e98f-4c9c-a9f9-58c757ff494f had a problem""",
                """blah <uuid> had a problem""",
            ),
            (
                "SHA1",
                """blah 5fc35719b9cf96ec602dbc748ff31c587a46961d had a problem""",
                """blah <sha1> had a problem""",
            ),
            (
                "MD5",
                """blah 0751007cd28df267e8e051b51f918c60 had a problem""",
                """blah <md5> had a problem""",
            ),
            (
                "Date",
                """blah 2022-01-15T08:30:00Z had a problem""",
                """blah <date> had a problem""",
            ),
            (
                "Date RFC822",
                """blah Mon, 02 Jan 06 15:04 MST had a problem""",
                """blah <date> had a problem""",
            ),
            (
                "Date RFC822Z",
                """blah Mon, 02 Jan 06 15:04 -0700 had a problem""",
                """blah <date> had a problem""",
            ),
            (
                "Date RFC850",
                """blah Monday, 02-Jan-06 15:04:05 MST had a problem""",
                """blah <date> had a problem""",
            ),
            (
                "Date RFC1123",
                """blah Mon, 02 Jan 2006 15:04:05 MST had a problem""",
                """blah <date> had a problem""",
            ),
            (
                "Date RFC1123Z",
                """blah Mon, 02 Jan 2006 15:04:05 -0700 had a problem""",
                """blah <date> had a problem""",
            ),
            (
                "Date RFC3339",
                """blah 2006-01-02T15:04:05Z07:00 had a problem""",
                """blah <date> had a problem""",
            ),
            (
                "Date RFC3339Nano",
                """blah 2006-01-02T15:04:05.999999999Z07:00 had a problem""",
                """blah <date> had a problem""",
            ),
            ("Date plain", """blah 2006-01-02 had a problem""", """blah <date> had a problem"""),
            ("Date - long", """blah Jan 18, 2019 had a problem""", """blah <date> had a problem"""),
            (
                "Date - Datetime",
                """blah 2006-01-02 15:04:05 had a problem""",
                """blah <date> had a problem""",
            ),
            ("Date - Kitchen", """blah 3:04PM had a problem""", """blah <date> had a problem"""),
            ("Date - Time", """blah 15:04:05 had a problem""", """blah <date> had a problem"""),
            ("hex", """blah 0x9af8c3b had a problem""", """blah <hex> had a problem"""),
            ("float", """blah 0.23 had a problem""", """blah <float> had a problem"""),
            ("int", """blah 23 had a problem""", """blah <int> had a problem"""),
            ("quoted str", """blah b="1" had a problem""", """blah b=<quoted_str> had a problem"""),
            ("bool", """blah a=true had a problem""", """blah a=<bool> had a problem"""),
            # New cases to handle better
            # ('''blah tcp://user:pass@email.com:10 had a problem''', '''blah <url> had a problem'''),
            # ('''blah 0.0.0.0:10 had a problem''', '''blah <ip> had a problem'''),
            # ('''blah Mon Jan 02, 1999 had a problem''', '''blah <date> had a problem'''),
            # ('''2024-02-20 11:55:33.546593 had a problem''', '''blah <date> had a problem'''),
            # Quoted Str w/ ints
            # ('''SQL: RELEASE SAVEPOINT "s140177518376768_x2"''', '''SQL: RELEASE SAVEPOINT "<quoted_str>"'''),
        ]
        for case in cases:
            assert case[2] == normalize_message_for_grouping(case[1]), f"Case {case[0]} Failed"
