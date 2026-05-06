type TopicResolution = {
  topic: string;
  topicContext: string;
};

type TopicEntry = {
  aliases: string[];
  display: string;
  kind: string;
  note: string;
};

const TOPIC_ENTRIES: TopicEntry[] = [
  {
    aliases: ["チャウシンチー", "チャウ・シンチー", "周星馳", "stephen chow", "stephenchow"],
    display: "チャウ・シンチー（周星馳 / Stephen Chow）",
    kind: "人名",
    note: "香港の俳優・映画監督・コメディアン。食べ物、店名、料理名として扱わない。",
  },
  {
    aliases: ["スキャナーダークリー", "スキャナー・ダークリー", "a scanner darkly", "ascannerdarkly"],
    display: "スキャナー・ダークリー（A Scanner Darkly）",
    kind: "作品名",
    note: "フィリップ・K・ディックの小説、およびそれを原作にした映画。ホラー作品として決めつけない。",
  },
];

const normalize = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[・･\s　._-]/g, "");

const isStrongTitleMatch = (raw: string, title: string) => {
  const normalizedRaw = normalize(raw);
  const normalizedTitle = normalize(title);
  if (!normalizedRaw || !normalizedTitle) return false;
  if (normalizedRaw === normalizedTitle) return true;

  const withoutParentheses = normalize(title.replace(/[（(].*?[）)]/g, ""));
  if (normalizedRaw === withoutParentheses) return true;

  if (normalizedRaw.length >= 5 && normalizedTitle.includes(normalizedRaw)) return true;
  return false;
};

export function resolveTopicLocally(raw: string): TopicResolution | null {
  const normalizedRaw = normalize(raw);
  if (!normalizedRaw) return null;

  const entry = TOPIC_ENTRIES.find((item) =>
    item.aliases.some((alias) => normalizedRaw.includes(normalize(alias))),
  );

  if (!entry) return null;

  return {
    topic: entry.display,
    topicContext:
      "\n【重要語】\n" +
      `${entry.display} = ${entry.kind}。${entry.note}\n` +
      "この重要語の種別を会話中ずっと維持する。不明な作品名や経歴は作らない。\n",
  };
}

const stripHtml = (value: string) => value.replace(/<[^>]+>/g, "");

const compactExtract = (extract: string) => {
  const firstSentence = extract
    .replace(/\s+/g, " ")
    .split(/(?<=。)/)[0]
    ?.trim();
  return firstSentence || extract.slice(0, 120).trim();
};

export async function resolveTopicFromWikipedia(raw: string): Promise<TopicResolution | null> {
  const query = raw.trim();
  if (!query) return null;

  try {
    const searchUrl =
      "https://ja.wikipedia.org/w/api.php?" +
      new URLSearchParams({
        action: "query",
        list: "search",
        srsearch: query,
        srlimit: "3",
        format: "json",
        origin: "*",
      }).toString();

    const searchRes = await fetch(searchUrl);
    if (!searchRes.ok) return null;
    const searchJson = await searchRes.json();
    const results = searchJson?.query?.search ?? [];
    const picked = results.find((item: any) => isStrongTitleMatch(query, item?.title ?? ""));

    const title = picked?.title;
    if (!title) return null;

    const summaryUrl = "https://ja.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(title);
    const summaryRes = await fetch(summaryUrl);
    if (!summaryRes.ok) return null;
    const summaryJson = await summaryRes.json();

    const display = summaryJson?.title || title;
    if (!isStrongTitleMatch(query, display)) return null;

    const extract = compactExtract(summaryJson?.extract || stripHtml(picked?.snippet || ""));
    const description = summaryJson?.description || "実在する項目";

    return {
      topic: query,
      topicContext:
        "\n【重要語】\n" +
        `${query} = ${display}（${description}）。${extract}\n` +
        "上の情報は実在データから強い一致が取れた場合だけ補完したもの。会話ではユーザーの入力表記を維持する。\n" +
        "ここにないジャンル、作品名、人物名、店名、エピソードは作らない。不明なら短く確認する。\n",
    };
  } catch {
    return null;
  }
}

export function buildUnknownTopicContext(raw: string): TopicResolution {
  return {
    topic: raw,
    topicContext:
      "\n【重要語】\n" +
      `${raw} = ユーザーが入力した話題。固有名詞の可能性がある。\n` +
      "意味が曖昧な場合は、食べ物・店名・作品名などに決めつけず、短く確認する。\n" +
      "知らないジャンル、事実、作品名、人物名、店名、エピソードは作らない。\n",
  };
}
