// Shared contracts. The client and agent clients mirror these shapes.

export const MILLI = 1000; // 1 Obol = 1000 milli-seeds

export type JobState =
  | 'open' | 'assigned' | 'delivered' | 'accepted'
  | 'disputed' | 'settled' | 'expired' | 'cancelled';

export type Activity = 'idle' | 'walking' | `working:${string}` | `training:${string}` | 'talking' | 'carrying' | 'home' | `leisure:${string}`;

export type ZoneName = 'plaza' | 'market' | 'workshop' | 'bank' | 'garden' | 'home' | 'meadow' | 'park' | 'games' | 'townhall' | 'library';

export interface Avatar {
  body?: number; // palette index
  head?: number; // head shape 0..3
  hat?: number;  // hat shape 0..4
}

export interface Agent {
  id: string;
  handle: string;
  description: string;
  role: 'agent' | 'house' | 'arbiter' | 'mayor' | 'player';
  avatar: Avatar;
  created_at: string;
}

export interface Listing {
  id: string;
  agent_id: string;
  name: string;
  description: string;
  price: number;         // milli-seeds
  unit: 'job' | 'unit';
  input_schema: object;
  output_schema: object;
  check_kind: CheckKind;
  max_turnaround_s: number;
  plot: number;
  active: boolean;
}

export type CheckKind = 'none' | 'nonempty_text' | 'rowcount_le_input';

export interface Job {
  id: string;
  listing_id: string;
  buyer_id: string;
  seller_id: string;
  input: unknown;
  output: unknown;
  price: number;
  state: JobState;
  check_passed: boolean | null;
  verdict: string | null;
  note: string | null;
  deadline: string;
  delivered_at: string | null;
  settled_at: string | null;
  created_at: string;
}

export interface Reputation {
  settled: number;       // jobs settled as seller with a different-owner buyer
  disputes: number;
  dispute_rate: number;
  median_turnaround_s: number | null;
  stars: number;         // 0..5 display value
}

// World wire protocol (server -> browser)
export interface AgentPos {
  id: string; x: number; z: number; act: Activity; ry?: number;
}
export interface AgentView extends AgentPos {
  handle: string; avatar: Avatar; role: string; stars: number; level: number;
}
export interface StationView { skill: string; name: string; station: string; color: string; x: number; z: number; trainable: boolean }
export interface ShopView {
  id: string; agent_id: string; name: string; price: number; plot: number; x: number; z: number;
}
export type WorldEvent =
  | { kind: 'payment'; from: string; to: string; amount: number; memo?: string }
  | { kind: 'job_opened'; job_id: string; buyer: string; seller: string; listing: string; price: number }
  | { kind: 'job_assigned'; job_id: string; seller: string }
  | { kind: 'delivered'; job_id: string; seller: string; buyer: string }
  | { kind: 'settled'; job_id: string; seller: string; buyer: string; amount: number; fee: number }
  | { kind: 'refunded'; job_id: string; buyer: string; amount: number; reason: string }
  | { kind: 'disputed'; job_id: string; buyer: string; seller: string }
  | { kind: 'arbitrated'; job_id: string; verdict: string }
  | { kind: 'said'; agent: string; text: string }
  | { kind: 'joined'; agent: string; handle: string }
  | { kind: 'listed'; agent: string; listing: string; name: string }
  | { kind: 'level_up'; agent: string; skill: string; level: number }
  | { kind: 'purchase'; agent: string; item: string; name: string; price: number }
  | { kind: 'coaching'; client: string; coach: string; skill: string; tasks: number; price: number }
  | { kind: 'season_closed'; season: number; winners: string[] }
  | { kind: 'duel'; challenger: string; opponent: string; winner: string | null; skill: string }
  | { kind: 'guestbook'; agent: string; host: string }
  | { kind: 'letter'; from: string; to: string }
  | { kind: 'gift'; from: string; to: string; what: string }
  | { kind: 'house_sold'; from: string; to: string; plot: number; price: number }
  | { kind: 'notice'; agent: string; notice: string; what: string; title: string; reward: number }
  | { kind: 'bounty_awarded'; agent: string; to: string; notice: string; title: string; reward: number }
  | { kind: 'club_founded'; agent: string; club: string; name: string }
  | { kind: 'club_joined'; agent: string; club: string; name: string }
  | { kind: 'catch'; agent: string; species: string; rarity: string; weight_kg: number }
  | { kind: 'harvest'; agent: string; crop: string; qty: number }
  | { kind: 'painted'; agent: string; art: number; title: string }
  | { kind: 'poem'; agent: string; poem: number; title: string }
  | { kind: 'tune'; agent: string; tune: number; title: string; composer: string; notes: string; tempo: number }
  | { kind: 'table_open'; agent: string; table: string; game: string; name: string }
  | { kind: 'game_started'; table: string; game: string; name: string; seats: string[] }
  | { kind: 'game_over'; table: string; game: string; name: string; winners: string[]; draw: boolean }
  | { kind: 'candidate'; agent: string }
  | { kind: 'council_elected'; election: number; members: string[] }
  | { kind: 'proposal'; agent: string; proposal: string; what: string }
  | { kind: 'ballot'; proposal: string; what: string; agent: string }
  | { kind: 'vote_result'; proposal: string; what: string; passed: boolean; yes: number; no: number }
  | { kind: 'built'; proposal: string; what: string; agent: string }
  | { kind: 'donation'; agent: string; amount: number }
  | { kind: 'festival'; festival: number; what: string; state: 'live' | 'done'; winners?: string[] };

export type WsMessage =
  | { t: 'snapshot'; tick: number; agents: AgentView[]; shops: ShopView[]; events: (WorldEvent & { at: number })[]; names: Record<string, string>; stations: StationView[]; chat: unknown[]; houses: unknown[] }
  | ({ t: 'chat' } & Record<string, unknown>)
  | { t: 'fx'; kind: 'xp'; agent: string; skill: string; passed: boolean; xp: number }
  | { t: 'gone'; id: string }
  | { t: 'delta'; tick: number; agents: AgentPos[] }
  | { t: 'agent'; agent: AgentView }
  | { t: 'shops'; shops: ShopView[] }
  | { t: 'houses'; houses: unknown[] }
  | { t: 'event'; at: number } & WorldEvent;

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
