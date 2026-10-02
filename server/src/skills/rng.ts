// Seeded PRNG (mulberry32) so every task is reproducible from its seed.
export class Rng {
  private s: number;
  constructor(seed: number) { this.s = seed >>> 0; }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(lo: number, hi: number): number { return lo + Math.floor(this.next() * (hi - lo + 1)); }
  pick<T>(xs: readonly T[]): T { return xs[Math.floor(this.next() * xs.length)]; }
  chance(p: number): boolean { return this.next() < p; }
  shuffle<T>(xs: T[]): T[] {
    for (let i = xs.length - 1; i > 0; i--) { const j = Math.floor(this.next() * (i + 1)); [xs[i], xs[j]] = [xs[j], xs[i]]; }
    return xs;
  }
  sample<T>(xs: readonly T[], n: number): T[] { return this.shuffle([...xs]).slice(0, n); }
}

export const NAMES = ['Ada', 'Bram', 'Cleo', 'Dov', 'Esme', 'Finn', 'Gia', 'Hugo', 'Iris', 'Jude', 'Kai', 'Lena', 'Milo', 'Nora',
  'Otto', 'Pia', 'Quin', 'Rosa', 'Sami', 'Tova', 'Uri', 'Vera', 'Wren', 'Xavi', 'Yara', 'Zeno'];
export const TOWNS = ['Brellow', 'Kess', 'Marrowgate', 'Tilby', 'Oakhollow', 'Wendle', 'Fairmoor', 'Duskwater', 'Pellam', 'Rookfield'];
export const JOBS = ['baker', 'cartographer', 'glassblower', 'beekeeper', 'clockmaker', 'ferrier', 'weaver', 'archivist', 'brewer', 'potter'];
export const PETS = ['cat', 'dog', 'goat', 'owl', 'tortoise', 'hare', 'parrot', 'ferret'];
export const PET_NAMES = ['Pebble', 'Juniper', 'Biscuit', 'Moss', 'Tansy', 'Clover', 'Sprocket', 'Nutmeg', 'Figaro', 'Quill', 'Saffron', 'Basil'];
export const COLOURS = ['amber', 'teal', 'crimson', 'olive', 'indigo', 'coral', 'slate', 'sage'];
export const CITIES = ['Lisbon', 'Osaka', 'Denver', 'Nairobi', 'Oslo', 'Lima', 'Perth', 'Quebec'];
export const ITEMS = ['lantern', 'rope', 'compass', 'tent', 'kettle', 'map', 'blanket', 'axe', 'flask', 'stove', 'boots', 'radio',
  'camera', 'saw', 'tarp', 'pickaxe', 'ladder', 'drill'];
export const WORDS = ('seed market garden lantern river merchant agent ledger coin window harbor meadow silver copper orchard '
  + 'winter summer morning evening quiet bright honest careful clever gentle rapid steady golden hidden northern southern '
  + 'bridge tower valley forest mountain village kitchen library workshop signal answer puzzle secret letter number table '
  + 'harvest weather candle feather basket ribbon thunder planet engine rocket compass journey promise reason pattern '
  + 'the a of and to in on with from under over near every many few some bakes carries finds opens closes follows '
  + 'guards counts sells buys trades writes reads builds keeps waters plants'
).split(' ');
export const NOUNS = WORDS.slice(0, 64);
export const VERBS = WORDS.slice(WORDS.indexOf('bakes'));
export const CIPHER_KEYS = ['orchid', 'lantern', 'harbor', 'copper', 'meadow', 'signal', 'prism', 'falcon', 'spark', 'willow',
  'thistle', 'garnet', 'raven', 'cobalt', 'neon', 'sage', 'marble', 'tundra', 'violet', 'anchor'];
