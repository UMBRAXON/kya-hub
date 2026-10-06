"""Unit tests for Moltbook lobster-math captcha solver."""
from __future__ import annotations

import unittest

from pr.moltbook_verify import _solve_word_math


class MoltbookVerifyTests(unittest.TestCase):
    def test_historical_fail_twenty_five_plus_fourteen(self) -> None:
        challenge = (
            "A] lOo.bSsTtEr'S^ ClAw] FoRcE- Is] tWeEnTy] fIiVee^ NoOtOnS, Um] "
            "aNd] AnOtHeR^ ClAw] HaS- fOuR]tEeN^ NoOtOnS~ WhAt'S] ThE] ToTaL^ FoRcE?"
        )
        self.assertEqual(_solve_word_math(challenge), "39.00")

    def test_historical_engage_thirty_five_plus_twenty_two(self) -> None:
        challenge = (
            "A] Lo-BsT eR] SwImS^ LiKe Um, Lo.oObSssTeR] ApPlIeS/ tHiRtY fIfE] "
            "NeWtOnS~ WiTh ClAw| PlUs{ WaTeR] PrEsSuRe/ Of< TwEnTy ]TwO, UhH, "
            "HoW/ MaNy> ToTaL?"
        )
        self.assertEqual(_solve_word_math(challenge), "57.00")

    def test_split_twenty_four(self) -> None:
        self.assertEqual(
            _solve_word_math("fIfTy nEwToNs ... aDdS tWeN tY fOuR nEwToNs"),
            "74.00",
        )

    def test_plain_english(self) -> None:
        self.assertEqual(
            _solve_word_math("twenty five newtons and fourteen"),
            "39.00",
        )


if __name__ == "__main__":
    unittest.main()
