// Country (ISO 3166-1 alpha-2) and language (ISO 639-1) codes, named in Chinese.

import type { ProviderInfo } from "./api";

export type CodeKind = "country" | "language";

const all: Record<CodeKind, string[]> = {
  country: (
    "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
    "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR " +
    "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP " +
    "KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ " +
    "NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW " +
    "SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ " +
    "UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW"
  ).split(" "),
  language: (
    "aa ab ae af ak am an ar as av ay az ba be bg bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz " +
    "ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu " +
    "ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my " +
    "na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw " +
    "sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty " +
    "ug uk ur uz ve vi vo wa wo xh yi yo za zh zu"
  ).split(" "),
};

/** Listed first, ahead of the rest in code order. */
const common: Record<CodeKind, string[]> = {
  country: ["CN", "US", "GB", "JP", "KR", "DE", "FR", "HK", "TW", "SG"],
  language: ["zh", "en", "ja", "ko", "de", "fr", "es", "ru"],
};

const names = {
  country: new Intl.DisplayNames(["zh-CN"], { type: "region", fallback: "none" }),
  language: new Intl.DisplayNames(["zh-CN"], { type: "language", fallback: "none" }),
};

/** "US 美国", or the bare code when it has no name. */
export function codeText(kind: CodeKind, code: string): string {
  const name = names[kind].of(code);
  return name ? `${code} ${name}` : code;
}

/** The codes to offer, common ones first, limited to `allowed` when given. */
export function codeGroups(kind: CodeKind, allowed?: string[]): { common: string[]; rest: string[] } {
  const list = allowed && allowed.length > 0 ? all[kind].filter((c) => allowed.includes(c)) : all[kind];
  return { common: common[kind].filter((c) => list.includes(c)), rest: list.filter((c) => !common[kind].includes(c)) };
}

/** Whether `provider` sends `code` as its search country or language. */
export function takes(provider: ProviderInfo, kind: CodeKind, code: string): boolean {
  const option = provider.options?.search?.find((o) => o.key === kind);
  return Boolean(option) && (!option!.values?.length || option!.values.includes(code));
}
