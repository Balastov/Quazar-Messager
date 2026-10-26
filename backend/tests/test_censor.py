"""Цензура ников, имён и фамилий: ловит мат в любом написании и не трогает настоящие фамилии."""

import unittest

from app.core.censor import find_violation
from app.core.profile import normalize_person_name, normalize_username
from app.schemas.user import UpdateProfile


class TestNicknames(unittest.TestCase):
    def test_blocks(self):
        cases = {
            "profanity": [
                "xyu_xyu", "cyka_blyat", "p1zdec", "bl9t", "huy", "zaebal", "dolboeb", "f4ck",
                "sh1thead", "eblan", "s_u_k_a", "muDaK", "ebanko", "gandon", "shluha", "yeban", "Hhhuuuuy",
            ],
            "insult": ["Vasya_Debil", "lox", "chmo", "ublyudok"],
            "slur": ["pidor", "niggaz", "zhidyara", "Hach"],
            "extremism": ["a14_88", "neonazi", "Hitler1", "zigheil", "isis"],
            "impersonation": [
                "admin_vasya", "QuazarSupport", "kvazar", "moderator2", "official_news", "quasar", "qwazar",
                "Qwasar_team", "kwazar", "kvasar", "kuazar", "qazar", "quazzar", "qu4zar", "cwasar", "the_QUASAR",
            ],
        }
        for category, nicks in cases.items():
            for nick in nicks:
                self.assertEqual(find_violation(nick, nickname=True), category, nick)

    def test_allows_real_words_and_names(self):
        for nick in [
            "badminton_fan", "Sukachev", "suchkov", "Shebalin", "amanda", "sebastian", "debate", "lebanon",
            "Huey", "yamashita", "shitov", "mudrov", "pizzeria", "Blokhin", "Khokhlov", "Churkin", "Zhidkov",
            "Hachaturyan", "Sukhanov", "alex88", "alexey_1990", "Peacock", "Hitchcock", "Cassandra", "Dickinson",
            "Ebenezer", "Slutsky", "Mraz", "Debanjan", "nikita", "Sukanya", "huge", "Lohan", "Michael", "kebab", "Caesar", "Kazarov",
            "kasar", "Ozar",
        ]:
            self.assertIsNone(find_violation(nick, nickname=True), nick)


class TestPersonNames(unittest.TestCase):
    def test_blocks(self):
        for name in [
            "Хуйло", "Пиздюк", "Ёбаный", "Бл9ть", "Xуй", "х у й", "Сука", "Мразь", "Дебил", "Жид", "Гитлер",
            "Администрация", "Поддержка Quazar", "Квазар", "Квасар", "Куазар", "Qwazar", "Ублюдок", "Шлюха", "Долбоёб", "Хууууй", "Пидорас", "Залупа",
        ]:
            self.assertIsNotNone(find_violation(name, nickname=False), name)

    def test_allows_real_names(self):
        for name in [
            "Сукачёв", "Сучков", "Шебалин", "Чебан", "Мудров", "Аманда", "Ребекка", "Себастьян", "Хуан", "Хуэй",
            "Гребенщиков", "Блохин", "Хохлов", "Чуркин", "Жидков", "Хачатурян", "Шитов", "Лохвицкая", "Небесная",
            "Хлебников", "Иван Петров", "Алла Пугачёва", "Mary-Jane", "Jean Luc", "李雷", "Дурасов", "Сукин",
            "Пушкин", "Хусейнов", "Ебель", "Шуйский", "Заболотный", "Набоков", "Дробышев",
        ]:
            self.assertIsNone(find_violation(name, nickname=False), name)


class TestValidators(unittest.TestCase):
    def test_messages_do_not_reveal_word(self):
        with self.assertRaises(ValueError) as ctx:
            normalize_username("cyka_blyat")
        self.assertIn("нецензурное слово", str(ctx.exception))
        self.assertNotIn("cyka", str(ctx.exception))

    def test_field_label(self):
        with self.assertRaises(ValueError) as ctx:
            UpdateProfile(last_name="Мразь")
        self.assertIn("Фамилия содержит оскорбление", str(ctx.exception))

    def test_existing_data_not_censored(self):
        # Перенос старого ника в имя — это уже существующие данные.
        self.assertEqual(normalize_person_name("Сука", censor=False), "Сука")


if __name__ == "__main__":
    unittest.main()
