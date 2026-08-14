const COCO_OBJECT_ALIASES: Readonly<Record<string, readonly string[]>> = {
  person: ['person', 'people', 'man', 'woman', 'boy', 'girl', 'nguoi', 'dan ong', 'phu nu', 'con trai', 'con gai'],
  bicycle: ['bicycle', 'bike', 'xe dap'],
  car: ['car', 'automobile', 'oto', 'xe hoi'],
  motorcycle: ['motorcycle', 'motorbike', 'xe may'],
  airplane: ['airplane', 'aeroplane', 'plane', 'may bay'],
  bus: ['bus', 'xe buyt'], train: ['train', 'tau hoa'], truck: ['truck', 'xe tai'], boat: ['boat', 'ship', 'thuyen', 'tau thuy'],
  'traffic light': ['traffic light', 'den giao thong'], 'fire hydrant': ['fire hydrant', 'tru nuoc cuu hoa'],
  'stop sign': ['stop sign', 'bien dung'], 'parking meter': ['parking meter', 'dong ho do xe'], bench: ['bench', 'ghe bang'],
  bird: ['bird', 'chim'], cat: ['cat', 'meo'], dog: ['dog', 'cho'], horse: ['horse', 'ngua'], sheep: ['sheep', 'con cuu'],
  cow: ['cow', 'con bo'], elephant: ['elephant', 'con voi'], bear: ['bear', 'con gau'], zebra: ['zebra', 'ngua van'], giraffe: ['giraffe', 'huou cao co'],
  backpack: ['backpack', 'rucksack', 'ba lo'], umbrella: ['umbrella', 'o du'], handbag: ['handbag', 'purse', 'tui xach'],
  tie: ['tie', 'necktie', 'ca vat'], suitcase: ['suitcase', 'luggage', 'vali'], frisbee: ['frisbee', 'dia bay'],
  skis: ['skis', 'ski'], snowboard: ['snowboard'], 'sports ball': ['sports ball', 'ball', 'qua bong'], kite: ['kite', 'con dieu'],
  'baseball bat': ['baseball bat', 'gay bong chay'], 'baseball glove': ['baseball glove', 'gang tay bong chay'],
  skateboard: ['skateboard', 'van truot'], surfboard: ['surfboard', 'van luot song'], 'tennis racket': ['tennis racket', 'vot tennis'],
  bottle: ['bottle', 'chai'], 'wine glass': ['wine glass', 'ly ruou'], cup: ['cup', 'mug', 'coc', 'cai ly'], fork: ['fork', 'cai nia'],
  knife: ['knife', 'con dao'], spoon: ['spoon', 'cai muong', 'cai thia'], bowl: ['bowl', 'cai to', 'cai bat'], banana: ['banana', 'qua chuoi'],
  apple: ['apple', 'tao'], sandwich: ['sandwich', 'banh mi kep'], orange: ['orange', 'qua cam'], broccoli: ['broccoli', 'bong cai xanh'],
  carrot: ['carrot', 'ca rot'], 'hot dog': ['hot dog'], pizza: ['pizza'], donut: ['donut', 'doughnut', 'banh vong'], cake: ['cake', 'banh ngot'],
  chair: ['chair', 'ghe'], couch: ['couch', 'sofa', 'ghe sofa'], 'potted plant': ['potted plant', 'chau cay'], bed: ['bed', 'giuong'],
  'dining table': ['dining table', 'table', 'ban an', 'cai ban'], toilet: ['toilet', 'bon cau'], tv: ['tv', 'television', 'ti vi'],
  laptop: ['laptop', 'may tinh xach tay'], mouse: ['computer mouse', 'chuot may tinh'], remote: ['remote', 'remote control', 'dieu khien'],
  keyboard: ['keyboard', 'ban phim'], 'cell phone': ['cell phone', 'mobile phone', 'phone', 'dien thoai'],
  microwave: ['microwave', 'lo vi song'], oven: ['oven', 'lo nuong'], toaster: ['toaster', 'may nuong banh'], sink: ['sink', 'bon rua'],
  refrigerator: ['refrigerator', 'fridge', 'tu lanh'], book: ['book', 'sach'], clock: ['clock', 'dong ho'], vase: ['vase', 'binh hoa'],
  scissors: ['scissors', 'cai keo'], 'teddy bear': ['teddy bear', 'gau bong'], 'hair drier': ['hair drier', 'hair dryer', 'may say toc'],
  toothbrush: ['toothbrush', 'ban chai danh rang'],
};

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1, mot: 1, two: 2, hai: 2, three: 3, ba: 3, four: 4, bon: 4,
  five: 5, nam: 5, six: 6, sau: 6, seven: 7, bay: 7, eight: 8, tam: 8,
  nine: 9, chin: 9, ten: 10, muoi: 10,
};

export function foldVietnamese(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
}

export function normalizeObjectText(value: string): string {
  return foldVietnamese(value).normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function containsPhrase(haystack: string, phrase: string): boolean {
  return (` ${haystack} `).includes(` ${phrase} `);
}

function pluralizeCanonical(label: string): string {
  const irregular: Readonly<Record<string, string>> = { person: 'people', mouse: 'mice' };
  if (irregular[label]) return irregular[label];
  const words = label.split(' ');
  const last = words.at(-1) ?? label;
  const plural = /[^aeiou]y$/.test(last) ? `${last.slice(0, -1)}ies`
    : /(s|x|z|ch|sh)$/.test(last) ? `${last}es` : `${last}s`;
  return [...words.slice(0, -1), plural].join(' ');
}

const SORTED_ALIASES = Object.entries(COCO_OBJECT_ALIASES)
  .flatMap(([canonical, aliases]) => [...new Set([...aliases, pluralizeCanonical(canonical)])]
    .map((alias) => ({ canonical, alias: normalizeObjectText(alias) })))
  .sort((left, right) => right.alias.length - left.alias.length || left.canonical.localeCompare(right.canonical));

export interface ObjectQueryExtraction {
  readonly terms: string[];
  readonly counts: Readonly<Record<string, number>>;
  readonly spatial: string[];
}

export function extractObjectQuery(query: string): ObjectQueryExtraction {
  const normalized = normalizeObjectText(query);
  const terms = new Set<string>();
  const counts: Record<string, number> = {};

  for (const { canonical, alias } of SORTED_ALIASES) {
    if (!containsPhrase(normalized, alias)) continue;
    terms.add(canonical);
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const countMatch = normalized.match(new RegExp(`(?:^|\\s)(\\d+|${Object.keys(NUMBER_WORDS).join('|')})\\s+${escaped}(?:\\s|$)`));
    if (countMatch) counts[canonical] = Number(countMatch[1]) || NUMBER_WORDS[countMatch[1]];
  }

  const spatial: string[] = [];
  const spatialRules: ReadonlyArray<readonly [string, RegExp]> = [
    ['left', /\b(left|ben trai|phia trai)\b/], ['right', /\b(right|ben phai|phia phai)\b/],
    ['top', /\b(top|above|phia tren|ben tren)\b/], ['bottom', /\b(bottom|below|phia duoi|ben duoi)\b/],
    ['inside', /\b(inside|in|ben trong|trong)\b/], ['near', /\b(near|next to|gan|ben canh)\b/],
  ];
  for (const [name, pattern] of spatialRules) if (pattern.test(normalized)) spatial.push(name);

  return { terms: [...terms], counts, spatial };
}

export function objectAliases(canonicalLabel: string): readonly string[] {
  return COCO_OBJECT_ALIASES[canonicalLabel] ?? [canonicalLabel];
}
