"""Цензура никнеймов, имён и фамилий: мат, оскорбления, экстремизм, выдача себя за сервис.

Проверяются только новые значения (регистрация и правка профиля) — уже сохранённые не трогаем.

Как читаем текст. Ник латиницей прячут по-разному: «pizda», «xyu», «cyka», «p1zd», «bl9t»,
«хуууй», «Vasya_Debil». Поэтому каждый кусок проверяем в нескольких прочтениях:
- латиница с leet-заменами (f4ck → fack, sh1t → shit) — для английских слов;
- фонетический транслит в кириллицу (pizda → пизда, blyat → блят, 9 → я, 3 → з);
- визуальные двойники (xyu → хуи, cyka → сука, латинская «X» в кириллическом слове);
- и каждое ещё со схлопнутыми повторами букв (хуууй → хуй).

Чтобы не страдали настоящие фамилии, корни мата ищем с оглядкой на соседние буквы
(Шебалин, Сукачёв, Сучков, Мудров, Аманда, Debate, Lebanon проходят), а обидные слова
и национальные оскорбления — только целым словом (Блохин, Хохлов, Чуркин, Жидков, Хачатурян
проходят). Ложное срабатывание — дописать исключение в ALLOWED или поправить шаблон и тест.
"""

import re
import unicodedata

# Что не так — без самого слова: не подсказываем, как обойти.
MESSAGES = {
    "profanity": "нецензурное слово",
    "insult": "оскорбление",
    "slur": "оскорбление по национальности или ориентации",
    "extremism": "экстремистскую символику",
    "impersonation": "слова, по которым вас примут за администрацию Quazar",
}

# Целые слова и основы, которые иначе зацепило бы шаблоном (латиница, в нижнем регистре).
ALLOWED = ("badminton", "scunthorpe", "huey", "huert", "shiitake")

# --- Шаблоны по кириллице (после ё → е). Ищутся внутри слова. ---
_CYR_SUBSTR = [
    ("profanity", r"ху[йеиюя]"),
    ("profanity", r"п[ие]зд|писд"),
    # еб- только в начале слова или после гласной / ъ / ь (заеб, уеб, долбоеб),
    # иначе цепляет фамилии: Шебалин, Чебан, Лебанон, debate.
    ("profanity", r"(?<![бвгджзклмнпрстфхцчшщ])еб(?:ан|ал|ат|аш|ну|л[аиоу]|уч|ук|ет|еш|ис|ыр|ар|ок)"),
    # Приставка + еб на конце слова: долбоеб, проеб, заеб.
    ("profanity", r"долба?о?еб|(?:за|вы|до|на|отъ|оть|про|съ|сь|разъ|подъ|при|пере)еб|(?<![а-я])уеб"),
    ("profanity", r"(?<!о)бля(?![хш])"),
    ("profanity", r"муда[кч]|мудил|мудозвон"),
    ("profanity", r"г[ао]нд[оа]н"),
    ("profanity", r"шл[юу]х|шалав"),
    ("profanity", r"залуп"),
    ("profanity", r"сука(?![чн])|сучар|сучий|сучь|сучк(?!ов)"),
    ("profanity", r"(?<![ар])манда(?![ртл])|мандавош"),
    ("profanity", r"жоп[аеуыо]"),
    ("profanity", r"говн[оаюуе]|дерьм|засран|сран[ыаоь]"),
    ("profanity", r"минет(?!т)|отсос|дроч|порн"),
    ("insult", r"ублюд|мраз[ьио]|выродок"),
    ("slur", r"пид[оа]р|пидр[аи]л|педераст|педрил"),
    ("slur", r"ниггер|нигга|негритос|черножоп|чернозад"),
    ("extremism", r"нацист|нацизм|неонаци|гитлер|зигхайл|хайльгитлер|свастик|игил|алькаид|талибан|колумбайн|скулшут"),
    # Название сервиса в любом написании: квазар, квасар, куазар.
    ("impersonation", r"к[ву]а[зс]ар|админ|модератор|поддержк|администрац|официальн"),
]

# --- Только целым словом (кириллица). ---
_CYR_WORDS = {
    "insult": """лох лохи лошара урод уроды чмо дебил дебилка дебилы даун дауны идиот идиотка
        кретин дура дурак тварь твари мразь сволочь скотина придурок имбецил гнида падла шмара тупица""",
    "slur": """жид жиды жидовка жидяра хач хачи чурка чурки чурбан хохол хохлы кацап кацапы москаль
        москали чучмек пиндос пиндосы гомик педик узкоглазый""",
    "extremism": "наци ауе",
    "impersonation": "система бот модер поддержка избранное",
}

# --- Латиница (после leet-замен). Ищутся внутри слова. ---
_LAT_SUBSTR = [
    ("profanity", r"f[ua]ck|fuk(?![uo])|fck|phuck|motherf"),
    # shita — японские фамилии (Yamashita, Matsushita), shito — Шитов.
    ("profanity", r"shit(?![aoi])|bitch|(?<!s)cunt|whore|slut(?!sk)|asshole|arsehole|bastard"),
    ("profanity", r"dickhead|cocksuck|pussy|porn|penis|blowjob|handjob|(?<!s)wank|jerkoff"),
    ("slur", r"nigg|faggot|retard"),
    ("extremism", r"neonazi|hitler|siegheil|zigheil|heilhitler|swastika|alqa[ei]da|taliban|columbine|schoolshoot|whitepower"),
    # quazar, quasar, qwazar, kwazar, kvasar, kuazar, qazar.
    ("impersonation", r"(?:qu|qw|q|kw|kv|ku|cu|cw)a[sz]ar|admin|moderator|support|official"),
]

# --- Только целым словом (латиница). ---
_LAT_WORDS = {
    "profanity": "dick cock ass twat sex anal cum",
    "slur": "fag fags chink kike spic gook tranny",
    "extremism": "nazi nazis heil isis aue kkk",
    "impersonation": "staff system mod mods bot",
}


def _compile(rules: list[tuple[str, str]]) -> list[tuple[str, re.Pattern]]:
    return [(cat, re.compile(p)) for cat, p in rules]


def _words(table: dict[str, str]) -> dict[str, str]:
    return {w: cat for cat, words in table.items() for w in words.split()}


CYR_SUBSTR = _compile(_CYR_SUBSTR)
LAT_SUBSTR = _compile(_LAT_SUBSTR)
CYR_WORDS = _words(_CYR_WORDS)
LAT_WORDS = _words(_LAT_WORDS)

# leet для английских слов: f4ck, sh1t, a55hole.
_LATIN_LEET = str.maketrans({"0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "@": "a", "$": "s"})
# leet для русского транслита: pi3da (з), 4mo (ч), 6lya (б), bl9t (я).
_RU_LEET = {"0": "o", "1": "i", "3": "z", "4": "ch", "6": "b", "9": "ya", "@": "a", "$": "s"}

_PHONETIC_PAIRS = [
    ("shch", "щ"), ("sch", "щ"), ("zh", "ж"), ("kh", "х"), ("ch", "ч"), ("sh", "ш"), ("ts", "ц"),
    ("yu", "ю"), ("ya", "я"), ("yo", "е"), ("ye", "е"), ("ju", "ю"), ("ja", "я"), ("jo", "е"),
    ("ck", "к"), ("ph", "ф"),
]
_PHONETIC_ONE = {
    "a": "а", "b": "б", "c": "к", "d": "д", "e": "е", "f": "ф", "g": "г", "h": "х", "i": "и",
    "j": "й", "k": "к", "l": "л", "m": "м", "n": "н", "o": "о", "p": "п", "q": "к", "r": "р",
    "s": "с", "t": "т", "u": "у", "v": "в", "w": "в", "x": "х", "z": "з",
}
_VOWELS = set("аеиоуыэюяaeiouy")

# Латинские и цифровые двойники кириллицы: xyu → хуи, cyka → сука, 6ля → бля.
_VISUAL = str.maketrans({
    "a": "а", "c": "с", "e": "е", "h": "н", "k": "к", "m": "м", "o": "о", "p": "р", "t": "т",
    "x": "х", "y": "у", "u": "и", "n": "п", "r": "г", "3": "з", "4": "ч", "6": "б", "0": "о",
    "9": "я", "@": "а",
})


def _phonetic(text: str) -> str:
    """Латиница (и русский leet) → кириллица: pizda → пизда, huy → хуй, bl9t → блят."""
    s = "".join(_RU_LEET.get(ch, ch) for ch in text)
    out: list[str] = []
    i = 0
    while i < len(s):
        for lat, cyr in _PHONETIC_PAIRS:
            if s.startswith(lat, i):
                out.append(cyr)
                i += len(lat)
                break
        else:
            ch = s[i]
            if ch == "y":
                # После гласной — й (huy → хуй), иначе ы.
                out.append("й" if out and out[-1] in _VOWELS else "ы")
            else:
                out.append(_PHONETIC_ONE.get(ch, ch))
            i += 1
    return "".join(out)


def _collapse(text: str) -> str:
    return re.sub(r"(.)\1+", r"\1", text)


def _readings(text: str) -> tuple[set[str], set[str]]:
    """Все прочтения куска: (кириллические, латинские), каждое и со схлопнутыми повторами."""
    cyr = {_phonetic(text), text.translate(_VISUAL)}
    lat = {text.translate(_LATIN_LEET)} if text.isascii() else set()
    return cyr | {_collapse(t) for t in cyr}, lat | {_collapse(t) for t in lat}


def _tokens(value: str) -> list[str]:
    """Слова: разрезаем по пробелам, «_», «.», «-» и на стыке camelCase (VasyaDebil)."""
    s = re.sub(r"(?<=[a-zа-яё0-9])(?=[A-ZА-ЯЁ])", " ", unicodedata.normalize("NFKC", value))
    s = s.lower().replace("ё", "е")
    for allowed in ALLOWED:
        s = s.replace(allowed, " ")
    return [t for t in re.split(r"[\W_]+", s) if t]


def _check_word(token: str) -> str | None:
    cyr, lat = _readings(token)
    for t in cyr:
        if t in CYR_WORDS:
            return CYR_WORDS[t]
    for t in lat:
        if t in LAT_WORDS:
            return LAT_WORDS[t]
    return None


def _check_substr(chunk: str) -> str | None:
    cyr, lat = _readings(chunk)
    for cat, pattern in CYR_SUBSTR:
        if any(pattern.search(t) for t in cyr):
            return cat
    for cat, pattern in LAT_SUBSTR:
        if any(pattern.search(t) for t in lat):
            return cat
    return None


def find_violation(value: str, *, nickname: bool) -> str | None:
    """Категория нарушения (ключ MESSAGES) или None.

    nickname=True: слова в нике пишут слитно и разделяют «_» и «.» — корни ищем и по всему нику
    целиком (s_u_k_a). В имени склеиваем только подряд идущие одиночные буквы (х у й),
    чтобы стык имени и фамилии не давал ложных совпадений.
    """
    tokens = _tokens(value)
    if "1488" in re.sub(r"\D", "", value):
        return "extremism"

    chunks = list(tokens)
    if nickname:
        chunks.append("".join(tokens))
    else:
        run: list[str] = []
        for t in [*tokens, ""]:
            if len(t) == 1:
                run.append(t)
                continue
            if len(run) > 1:
                chunks.append("".join(run))
            run = []

    for token in tokens:
        if cat := _check_word(token):
            return cat
    for chunk in chunks:
        if cat := _check_substr(chunk):
            return cat
    return None


def violation_message(category: str) -> str:
    return MESSAGES[category]
