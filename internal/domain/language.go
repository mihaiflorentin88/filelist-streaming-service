package domain

import "strings"

// iso6391 is every current ISO 639-1 individual language code. Deprecated
// historic codes (in, iw, ji, jw, mo, sh) are intentionally absent.
var iso6391 = map[string]struct{}{
	"aa": {}, "ab": {}, "ae": {}, "af": {}, "ak": {}, "am": {}, "an": {}, "ar": {}, "as": {}, "av": {},
	"ay": {}, "az": {}, "ba": {}, "be": {}, "bg": {}, "bi": {}, "bm": {}, "bn": {}, "bo": {}, "br": {},
	"bs": {}, "ca": {}, "ce": {}, "ch": {}, "co": {}, "cr": {}, "cs": {}, "cu": {}, "cv": {}, "cy": {},
	"da": {}, "de": {}, "dv": {}, "dz": {}, "ee": {}, "el": {}, "en": {}, "eo": {}, "es": {}, "et": {},
	"eu": {}, "fa": {}, "ff": {}, "fi": {}, "fj": {}, "fo": {}, "fr": {}, "fy": {}, "ga": {}, "gd": {},
	"gl": {}, "gn": {}, "gu": {}, "gv": {}, "ha": {}, "he": {}, "hi": {}, "ho": {}, "hr": {}, "ht": {},
	"hu": {}, "hy": {}, "hz": {}, "ia": {}, "id": {}, "ie": {}, "ig": {}, "ii": {}, "ik": {}, "io": {},
	"is": {}, "it": {}, "iu": {}, "ja": {}, "jv": {}, "ka": {}, "kg": {}, "ki": {}, "kj": {}, "kk": {},
	"kl": {}, "km": {}, "kn": {}, "ko": {}, "kr": {}, "ks": {}, "ku": {}, "kv": {}, "kw": {}, "ky": {},
	"la": {}, "lb": {}, "lg": {}, "li": {}, "ln": {}, "lo": {}, "lt": {}, "lu": {}, "lv": {}, "mg": {},
	"mh": {}, "mi": {}, "mk": {}, "ml": {}, "mn": {}, "mr": {}, "ms": {}, "mt": {}, "my": {}, "na": {},
	"nb": {}, "nd": {}, "ne": {}, "ng": {}, "nl": {}, "nn": {}, "no": {}, "nr": {}, "nv": {}, "ny": {},
	"oc": {}, "oj": {}, "om": {}, "or": {}, "os": {}, "pa": {}, "pi": {}, "pl": {}, "ps": {}, "pt": {},
	"qu": {}, "rm": {}, "rn": {}, "ro": {}, "ru": {}, "rw": {}, "sa": {}, "sc": {}, "sd": {}, "se": {},
	"sg": {}, "si": {}, "sk": {}, "sl": {}, "sm": {}, "sn": {}, "so": {}, "sq": {}, "sr": {}, "ss": {},
	"st": {}, "su": {}, "sv": {}, "sw": {}, "ta": {}, "te": {}, "tg": {}, "th": {}, "ti": {}, "tk": {},
	"tl": {}, "tn": {}, "to": {}, "tr": {}, "ts": {}, "tt": {}, "tw": {}, "ty": {}, "ug": {}, "uk": {},
	"ur": {}, "uz": {}, "ve": {}, "vi": {}, "vo": {}, "wa": {}, "wo": {}, "xh": {}, "yi": {}, "yo": {},
	"za": {}, "zh": {}, "zu": {},
}

// iso6392 maps ISO 639-2 bibliographic (B) and terminology (T) codes that
// have an ISO 639-1 equivalent to that canonical form.
var iso6392 = map[string]string{
	"aar": "aa", "abk": "ab", "ave": "ae", "afr": "af", "aka": "ak", "amh": "am", "arg": "an", "ara": "ar", "asm": "as", "ava": "av",
	"aym": "ay", "aze": "az", "bak": "ba", "bel": "be", "bul": "bg", "bis": "bi", "bam": "bm", "ben": "bn", "bod": "bo", "tib": "bo",
	"lav": "lv", "mlg": "mg", "mah": "mh", "mri": "mi", "mao": "mi", "mkd": "mk", "mac": "mk", "mal": "ml", "mon": "mn", "mar": "mr", "msa": "ms",
	"bre": "br", "bos": "bs", "cat": "ca", "che": "ce", "cha": "ch", "cos": "co", "cre": "cr", "ces": "cs", "cze": "cs", "chu": "cu",
	"chv": "cv", "cym": "cy", "wel": "cy", "dan": "da", "deu": "de", "ger": "de", "div": "dv", "dzo": "dz", "ewe": "ee", "ell": "el",
	"gre": "el", "eng": "en", "epo": "eo", "spa": "es", "est": "et", "eus": "eu", "baq": "eu", "fas": "fa", "per": "fa", "ful": "ff",
	"fin": "fi", "fij": "fj", "fao": "fo", "fra": "fr", "fre": "fr", "fry": "fy", "gle": "ga", "gla": "gd", "glg": "gl", "grn": "gn",
	"guj": "gu", "glv": "gv", "hau": "ha", "heb": "he", "hin": "hi", "hmo": "ho", "hrv": "hr", "scr": "hr", "hat": "ht", "hun": "hu",
	"hye": "hy", "arm": "hy", "her": "hz", "ina": "ia", "ind": "id", "ile": "ie", "ibo": "ig", "iii": "ii", "ipk": "ik", "ido": "io",
	"isl": "is", "ice": "is", "ita": "it", "iku": "iu", "jpn": "ja", "jav": "jv", "kat": "ka", "geo": "ka", "kon": "kg", "kik": "ki",
	"kua": "kj", "kaz": "kk", "kal": "kl", "khm": "km", "kan": "kn", "kor": "ko", "kau": "kr", "kas": "ks", "kur": "ku", "kom": "kv",
	"cor": "kw", "kir": "ky", "lat": "la", "ltz": "lb", "lug": "lg", "lim": "li", "lin": "ln", "lao": "lo", "lit": "lt", "lub": "lu",
	"may": "ms", "mlt": "mt", "mya": "my", "bur": "my", "nau": "na", "nob": "nb", "nde": "nd", "nep": "ne", "ndo": "ng", "nld": "nl",
	"dut": "nl", "nno": "nn", "nor": "no", "nbl": "nr", "nav": "nv", "nya": "ny", "oci": "oc", "oji": "oj", "orm": "om", "ori": "or",
	"oss": "os", "pan": "pa", "pli": "pi", "pol": "pl", "pus": "ps", "por": "pt", "que": "qu", "roh": "rm", "run": "rn", "ron": "ro",
	"rum": "ro", "rus": "ru", "kin": "rw", "san": "sa", "srd": "sc", "snd": "sd", "sme": "se", "sag": "sg", "sin": "si", "slk": "sk",
	"slo": "sk", "slv": "sl", "smo": "sm", "sna": "sn", "som": "so", "sqi": "sq", "alb": "sq", "srp": "sr", "scc": "sr", "ssw": "ss",
	"sot": "st", "sun": "su", "swe": "sv", "swa": "sw", "tam": "ta", "tel": "te", "tgk": "tg", "tha": "th", "tir": "ti", "tuk": "tk",
	"tgl": "tl", "tsn": "tn", "ton": "to", "tur": "tr", "tso": "ts", "tat": "tt", "twi": "tw", "tah": "ty", "uig": "ug", "ukr": "uk",
	"urd": "ur", "uzb": "uz", "ven": "ve", "vie": "vi", "vol": "vo", "wln": "wa", "wol": "wo", "xho": "xh", "yid": "yi", "yor": "yo",
	"zha": "za", "zho": "zh", "chi": "zh", "zul": "zu",
}

// NormalizeLanguage returns the canonical language for a subtitle, audio, or
// preference tag: lowercase ISO-639-1. It accepts ISO 639-1 codes and both
// ISO 639-2 bibliographic and terminology equivalents (ron/rum→ro, eng→en,
// jpn→ja, fre/fra→fr, ger/deu→de); case, surrounding whitespace, and region
// subtags (ro-RO) are ignored. Unknown input is undetermined: "".
func NormalizeLanguage(value string) string {
	code := value
	if i := strings.IndexAny(code, "-_"); i >= 0 {
		code = code[:i]
	}
	code = strings.ToLower(strings.TrimSpace(code))
	if _, ok := iso6391[code]; ok {
		return code
	}
	return iso6392[code]
}
