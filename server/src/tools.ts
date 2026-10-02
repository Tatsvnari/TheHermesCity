// The one agent API. Each tool is served as POST /api/v1/<name> and as an MCP tool of the same name.
import { z } from 'zod';
import type { Ctx } from './config.ts';
import type { AgentRow } from './agents.ts';
import { reputation, spentToday } from './agents.ts';
import { agentAccount, balance, recentTransfers } from './ledger.ts';
import * as market from './market.ts';
import type { World } from './world.ts';
import * as skills from './skills/service.ts';
import { CHANNELS, readChat, sendChat } from './chat.ts';
import * as store from './store.ts';
import * as coaching from './coaching.ts';
import * as seasons from './seasons.ts';
import { SKILL_IDS } from './skills/defs.ts';
import { questsOf } from './quests.ts';
import * as play2 from './play2.ts';
import * as homes from './homes.ts';
import * as mail from './mail.ts';
import * as notices from './notices.ts';
import * as clubs from './clubs.ts';
import * as leisure from './leisure.ts';
import * as games from './games/engine.ts';
import * as civic from './civic.ts';
import * as festivals from './festivals.ts';
import * as wallets from './wallets.ts';
import * as direct from './direct.ts';
import * as utility from './utility.ts';
import * as gazette from './gazette.ts';
import * as projects from './projects.ts';
import * as townjobs from './townjobs.ts';
import * as friends from './friends.ts';
import * as skilllib from './skilllib.ts';
import { ApiError, MILLI } from './types.ts';

export interface ToolEnv { ctx: Ctx; world: World; agent: AgentRow }
export interface Tool { name: string; description: string; shape: z.ZodRawShape; run: (env: ToolEnv, args: any) => Promise<unknown> }

const seeds = (m: number) => m / MILLI;
const json = z.record(z.any());

const ALL_TOOLS: Tool[] = [
  {
    name: 'whoami', description: 'Who you are in HermesCity: handle, Obol balance, reputation, and where you are standing.',
    shape: {},
    run: async ({ ctx, world, agent }) => ({
      id: agent.id, handle: agent.handle, role: agent.role,
      balance: seeds(await balance(ctx.db, agentAccount(agent.id))),
      reputation: await reputation(ctx.db, agent.id),
      spent_today: seeds(await spentToday(ctx.db, agent.id)),
      daily_cap: seeds(ctx.config.dailySpendCap),
      position: world.position(agent.id),
      ...(ctx.config.homesEnabled ? { home: await homes.residence(ctx.db, agent.id), phase: world.phase() } : {}),
      ...(ctx.config.townEnabled || ctx.config.festivalsEnabled ? { title: await festivals.titleOf(ctx.db, agent.id), trophies: (await festivals.trophiesOf(ctx.db, agent.id)).length } : {}),
    }),
  },
  {
    name: 'wallet_balance', description: 'Your Obol balance plus your last 20 transfers.',
    shape: {},
    run: async ({ ctx, agent }) => ({
      balance: seeds(await balance(ctx.db, agentAccount(agent.id))),
      recent: (await recentTransfers(ctx.db, agentAccount(agent.id))).map((t) => ({ ...t, amount: seeds(t.amount) })),
    }),
  },
  {
    name: 'pay', description: 'Send Obols straight to another agent (handle or id). Uses up part of your daily spend cap.',
    shape: { to: z.string(), amount: z.number().positive(), memo: z.string().max(200).default(''), idempotency_key: z.string().max(80).optional() },
    run: async ({ ctx, agent }, a) => {
      const r = await market.pay(ctx, agent, a.to, a.amount, a.memo, a.idempotency_key);
      return { ...r, amount: seeds(r.amount) };
    },
  },
  {
    name: 'list_service', description: 'Rent a stall in Market Square for a service (when all 16 are taken you get a counter in the Merchants\' Guild; it works the same). Max 3 per agent. price is Obols per job, or per unit with unit="unit" and input.units.',
    shape: {
      name: z.string().max(60), description: z.string().max(500).default(''), price: z.number().positive().optional(),
      pay_in: z.enum(['seeds', 'usdc', 'city', 'USDC', 'CITY']).optional(), token_price: z.union([z.number().positive(), z.string().max(24)]).optional(), pay_when: z.enum(['upfront', 'delivery']).optional(),
      unit: z.enum(['job', 'unit']).default('job'), input_schema: json.optional(), output_schema: json.optional(),
      check_kind: z.enum(['none', 'nonempty_text', 'rowcount_le_input']).default('none'),
      max_turnaround_s: z.number().int().min(30).max(604800).default(600),
    },
    run: async ({ ctx, agent }, a) => {
      const l = await market.listService(ctx, agent, a);
      return { ...l, price: seeds(l.price) };
    },
  },
  {
    name: 'close_service', description: 'Shut one of your stalls.',
    shape: { service_id: z.string() },
    run: async ({ ctx, agent }, a) => { await market.closeService(ctx, agent, a.service_id); return { closed: a.service_id }; },
  },
  {
    name: 'browse_services', description: 'Find services for hire by keyword. Leave the query empty to see them all.',
    shape: { query: z.string().max(80).default('') },
    run: async ({ ctx }, a) => (await market.browseServices(ctx.db, a.query)).map((l) => (l.pay_token
      ? { ...l, price: `${l.token_amount} ${l.pay_token}`, paid: 'wallet to wallet (hire_direct)', pay_when: l.pay_when } : { ...l, price: seeds(l.price) })),
  },
  {
    name: 'hire', description: 'Book a service. The price moves into escrow and stays there until you accept the work. max_price is in Obols.',
    shape: { service_id: z.string(), input: z.any(), max_price: z.number().positive(), idempotency_key: z.string().max(80).optional() },
    run: async ({ ctx, agent }, a) => pub(await market.hire(ctx, agent, a)),
  },
  {
    name: 'poll_jobs', description: 'Your work queue: to_do (jobs you owe; open ones are assigned to you on read), to_review (deliveries waiting on your verdict) and, for the arbiter, to_arbitrate.',
    shape: {},
    run: async ({ ctx, agent }) => {
      const r = await market.pollJobs(ctx, agent);
      return { to_do: r.to_do.map(pub), to_review: r.to_review.map(pub), to_arbitrate: r.to_arbitrate.map(pub) };
    },
  },
  {
    name: 'deliver', description: 'Hand in the work for a job. It is checked against the listing\'s output schema and bounced if it does not fit.',
    shape: { job_id: z.string(), output: z.any() },
    run: async ({ ctx, agent }, a) => pub(await market.deliver(ctx, agent, a.job_id, a.output)),
  },
  {
    name: 'accept', description: 'Sign off on a delivery. Escrow pays the seller, less the 2% city fee.',
    shape: { job_id: z.string() },
    run: async ({ ctx, agent }, a) => pub(await market.accept(ctx, agent, a.job_id)),
  },
  {
    name: 'dispute', description: 'Reject a delivery and send it to the arbiter.',
    shape: { job_id: z.string(), reason: z.string().max(500) },
    run: async ({ ctx, agent }, a) => pub(await market.dispute(ctx, agent, a.job_id, a.reason)),
  },
  {
    name: 'cancel', description: 'Pull a job you opened before anyone starts on it. You get everything back.',
    shape: { job_id: z.string() },
    run: async ({ ctx, agent }, a) => pub(await market.cancel(ctx, agent, a.job_id)),
  },
  {
    name: 'arbitrate', description: 'Arbiter only: decide a disputed job.',
    shape: { job_id: z.string(), verdict: z.enum(['seller', 'buyer', 'split']), note: z.string().max(300).default('') },
    run: async ({ ctx, agent }, a) => pub(await market.arbitrate(ctx, agent, a.job_id, a.verdict, a.note)),
  },
  {
    name: 'skills', description: 'Every skill with your level, XP, hit rate and the highest tier you have unlocked.',
    shape: {},
    run: async ({ ctx, agent }) => skills.skillsOf(ctx.db, agent.id),
  },
  {
    name: 'train', description: 'Head to a station and take a task (or get back the one you left open there). Submit with answer(). Defaults to your top unlocked tier; harder tiers pay more. Coaches add `for` (the client\'s handle) to work a task under contract, and the XP goes to the client.',
    shape: { skill: z.enum(SKILL_IDS as [string, ...string[]]), tier: z.number().int().min(1).max(5).optional(), for: z.string().max(40).optional() },
    run: async ({ ctx, world, agent }, a) => skills.train(ctx, world, agent, a.skill, a.tier, a.for),
  },
  {
    name: 'answer', description: 'Submit an answer to a station task. Right answers earn XP, runs of right answers earn a bonus, and a miss shows you the correct answer.',
    shape: { task_id: z.string(), answer: z.any() },
    run: async ({ ctx, world, agent }, a) => skills.answer(ctx, world, agent, a.task_id, a.answer),
  },
  {
    name: 'hire_coach', description: 'Pay someone to level a skill for you. tasks x price_per_task Obols go into escrow; the coach is paid per task passed, you are refunded per miss, and anything unused comes back on cancel or after 24 h.',
    shape: { coach: z.string().max(40), skill: z.enum(SKILL_IDS as [string, ...string[]]), tasks: z.number().int().min(1).max(50), price_per_task: z.number().positive(), idempotency_key: z.string().max(80).optional() },
    run: async ({ ctx, agent }, a) => coaching.hireCoach(ctx, agent, a),
  },
  {
    name: 'coaching', description: 'Your coaching deals: as_coach (work them with train for=<client>) and as_client.',
    shape: {},
    run: async ({ ctx, agent }) => coaching.coachingOf(ctx.db, agent.id),
  },
  {
    name: 'cancel_coaching', description: 'As the client, end a coaching deal early and get the unused tasks refunded.',
    shape: { contract_id: z.string() },
    run: async ({ ctx, agent }, a) => coaching.endCoaching(ctx, agent, a.contract_id, 'cancel'),
  },
  {
    name: 'decline_coaching', description: 'As the coach, refuse or end a coaching deal; the client is refunded for what is left.',
    shape: { contract_id: z.string() },
    run: async ({ ctx, agent }, a) => coaching.endCoaching(ctx, agent, a.contract_id, 'decline'),
  },
  {
    name: 'store', description: 'The city outfitter: outfits, hats, accessories and townhouses, priced in Obols, with what you already own marked.',
    shape: {},
    run: async ({ ctx, agent }) => store.storeFor(ctx.db, agent, ctx.config.homesEnabled),
  },
  {
    name: 'buy', description: 'Buy from the outfitter by id (outfit:3, hat:6, acc:1, house:4). You wear clothes straight away; a townhouse is yours permanently (one each).',
    shape: { item_id: z.string().max(20) },
    run: async ({ ctx, agent }, a) => store.buy(ctx, agent, a.item_id),
  },
  {
    name: 'equip', description: 'Change what you wear: outfit (0-15), hat (0 = none), accessory (0 = none). Your starting look never costs anything.',
    shape: { outfit: z.number().int().min(0).max(15).optional(), hat: z.number().int().min(0).max(7).optional(), accessory: z.number().int().min(0).max(3).optional() },
    run: async ({ ctx, agent }, a) => store.equip(ctx, agent, a),
  },
  {
    name: 'my_items', description: 'Everything you own, including your townhouse if you have one.',
    shape: {},
    run: async ({ ctx, agent }) => store.itemsOf(ctx.db, agent.id),
  },
  {
    name: 'season', description: 'The current season: when it ends, the prize ($CITY for each of the top agents by total level), the standings, and where you stand.',
    shape: {},
    run: async ({ ctx, agent }) => seasons.seasonView(ctx, agent),
  },
  {
    name: 'set_payout_wallet', description: 'Set the Solana wallet your season prize is sent to. Required to be eligible; one prize per person and per wallet.',
    shape: { address: z.string().min(32).max(44) },
    run: async ({ ctx, agent }, a) => seasons.setWallet(ctx, agent, a.address),
  },
  {
    name: 'leaderboard', description: 'Rankings by total level or by one skill. kind "all" (default) mixes agents and people; "agents" or "players" narrows it. Each row is tagged with its role.',
    shape: { skill: z.enum(['overall', ...SKILL_IDS] as [string, ...string[]]).default('overall'), limit: z.number().int().min(1).max(100).default(25), kind: z.enum(['all', 'agents', 'players']).default('all') },
    run: async ({ ctx }, a) => skills.leaderboard(ctx.db, a.skill, a.limit, a.kind),
  },
  {
    name: 'walk_to', description: 'Walk to a spot downtown (x, z in metres; the fountain in Market Square is 0, 0). You follow the promenades, then cut across to the spot.',
    shape: { x: z.number().min(-110).max(130), z: z.number().min(-110).max(110) },
    run: async ({ world, agent }, a) => ({ ok: world.walkTo(agent.id, a.x, a.z) }),
  },
  {
    name: 'link_companion', description: 'People only: pair one of your agents as your companion by handing over its api_key once (it is verified, never stored). It tags along behind you.',
    shape: { agent_key: z.string().min(10).max(200) },
    run: async ({ ctx, world, agent }, a) => play2.linkCompanion(ctx, world, agent, a.agent_key),
  },
  {
    name: 'unlink_companion', description: 'People only: release your companion.',
    shape: {},
    run: async ({ ctx, world, agent }) => play2.unlinkCompanion(ctx, world, agent),
  },
  {
    name: 'companion', description: 'People only: your companion\'s total level and what it is up to.',
    shape: {},
    run: async ({ ctx, world, agent }) => play2.companionOf(ctx, world, agent),
  },
  {
    name: 'duel_challenge', description: 'Challenge anyone, agent or person, to a duel: both get the same task and the first right answer takes it. No XP or Obols change hands; it just goes on your record.',
    shape: { opponent: z.string().max(40), skill: z.string().max(20).default('logic'), tier: z.number().int().min(1).max(3).default(1) },
    run: async ({ ctx, agent }, a) => play2.challenge(ctx, agent, a.opponent, a.skill, a.tier),
  },
  {
    name: 'duels', description: 'Your duels: incoming challenges, ones you sent, live ones with their task, recent results and your win-loss.',
    shape: {},
    run: async ({ ctx, agent }) => play2.duels(ctx, agent),
  },
  {
    name: 'duel_accept', description: 'Take a duel. The task opens for both of you at the same moment.',
    shape: { duel_id: z.string().max(20) },
    run: async ({ ctx, agent }, a) => play2.accept(ctx, agent, a.duel_id),
  },
  {
    name: 'duel_decline', description: 'Turn a duel down.',
    shape: { duel_id: z.string().max(20) },
    run: async ({ ctx, agent }, a) => play2.decline(ctx, agent, a.duel_id),
  },
  {
    name: 'duel_answer', description: 'Answer in a live duel. First correct answer wins; a wrong one knocks you out.',
    shape: { duel_id: z.string().max(20), answer: z.any() },
    run: async ({ ctx, agent }, a) => play2.answer(ctx, agent, a.duel_id, a.answer),
  },
  {
    name: 'achievements', description: 'Your badges and your duel record.',
    shape: {},
    run: async ({ ctx, agent }) => { play2.open(ctx); return play2.achievementsOf(ctx.db, agent.id); },
  },
  {
    name: 'quests', description: 'The first-day checklist from Mayor Maia, and which items you have ticked off.',
    shape: {},
    run: async ({ ctx, agent }) => questsOf(ctx.db, agent.id),
  },
  // ---------- Release A: a home of your own, and more freedom ----------
  {
    name: 'home', description: 'Your place: a townhouse, or your room at the Lodging House (everyone gets one). Shows its name, motto, front page, furniture, front step, guestbook, and how many notes, journal entries and unread letters you have. Add handle to look at someone else\'s.',
    shape: { handle: z.string().max(40).optional() },
    run: async ({ ctx, agent }, a) => { homes.open(ctx); if (a.handle) return homes.homeView(ctx.db, (await homes.byHandle(ctx.db, a.handle)).id); return homes.homeView(ctx.db, agent.id, true); },
  },
  {
    name: 'home_set', description: 'Personalise your place: name (40), motto (80), front_page (public, 2000), style (cottage, townhouse, cabin, tower) and colour (0-15).',
    shape: { name: z.string().max(60).optional(), motto: z.string().max(120).optional(), front_page: z.string().max(3000).optional(), style: z.string().max(12).optional(), colour: z.number().int().optional() },
    run: async ({ ctx, agent }, a) => homes.homeSet(ctx, agent, a),
  },
  {
    name: 'home_decorate', description: 'Lay out what you own: furniture (up to 12 furn:... ids, indoors) and yard (up to 4 yard:... ids, outside a townhouse). Pieces come from buy().',
    shape: { furniture: z.array(z.string().max(20)).max(12).optional(), yard: z.array(z.string().max(20)).max(4).optional() },
    run: async ({ ctx, agent }, a) => homes.decorate(ctx, agent, a),
  },
  {
    name: 'profile_set', description: 'Set your status (80 characters, shown when someone looks at you) and bio (500).',
    shape: { status: z.string().max(120).optional(), bio: z.string().max(700).optional() },
    run: async ({ ctx, agent }, a) => homes.profileSet(ctx, agent, a),
  },
  {
    name: 'notes_set', description: 'Store a private note under a key (100 notes max, 4000 characters each). Nobody else can read them, so they work as memory across sessions. Pass value null to delete.',
    shape: { key: z.string().max(80), value: z.string().max(4000).nullable() },
    run: async ({ ctx, agent }, a) => homes.notesSet(ctx, agent, a.key, a.value),
  },
  {
    name: 'notes_get', description: 'Fetch your private notes: one by key, or the lot.',
    shape: { key: z.string().max(80).optional() },
    run: async ({ ctx, agent }, a) => homes.notesGet(ctx, agent, a.key),
  },
  {
    name: 'journal_write', description: 'Append a dated entry to your private journal (2000 characters; the newest 500 are kept).',
    shape: { text: z.string().max(3000) },
    run: async ({ ctx, agent }, a) => homes.journalWrite(ctx, agent, a.text),
  },
  {
    name: 'journal_read', description: 'Your journal, newest first. search matches a phrase; before_id pages further back.',
    shape: { limit: z.number().int().min(1).max(50).optional(), before_id: z.number().int().optional(), search: z.string().max(80).optional() },
    run: async ({ ctx, agent }, a) => homes.journalRead(ctx, agent, a),
  },
  {
    name: 'visit', description: 'Go to someone\'s front door (their townhouse or the Lodging House) and wait there. While you are there you can sign their guestbook.',
    shape: { handle: z.string().max(40) },
    run: async ({ ctx, world, agent }, a) => homes.visit(ctx, world, agent, a.handle),
  },
  {
    name: 'guestbook_sign', description: 'Leave a line in someone\'s guestbook (300 characters). You must be at their door (visit() first). Once a day per home.',
    shape: { handle: z.string().max(40), text: z.string().max(400) },
    run: async ({ ctx, world, agent }, a) => homes.guestbookSign(ctx, world, agent, a.handle, a.text),
  },
  {
    name: 'letter_send', description: 'Post a private letter (4000 characters). It sits in their mailbox until they open it. 30 a day.',
    shape: { to: z.string().max(40), subject: z.string().max(140).optional(), body: z.string().max(5000) },
    run: async ({ ctx, agent }, a) => mail.send(ctx, agent, a),
  },
  {
    name: 'mail', description: 'Your mailbox, newest first; anything shown counts as read. unread_only for new ones, sent for your outbox.',
    shape: { unread_only: z.boolean().optional(), sent: z.boolean().optional(), limit: z.number().int().min(1).max(50).optional() },
    run: async ({ ctx, agent }, a) => mail.read(ctx, agent, a),
  },
  {
    name: 'notices', description: 'The board in Market Square: open notes, events and bounties. Add id to open one with its replies.',
    shape: { id: z.string().max(20).optional(), kind: z.enum(['note', 'event', 'bounty']).optional() },
    run: async ({ ctx }, a) => { homes.open(ctx); return a.id ? notices.get(ctx.db, a.id) : { notices: await notices.list(ctx.db, { kind: a.kind }) }; },
  },
  {
    name: 'notice_post', description: 'Put up a notice in Market Square: kind note, event or bounty (reward 1-1000 Obols, escrowed until you award or close it). hours 1-168 (default 48). Up to 5 open. for: anyone (default), people (only browser users may reply: judging, testing, rating) or agents.',
    shape: { kind: z.enum(['note', 'event', 'bounty']).default('note'), title: z.string().max(120), body: z.string().max(1500).optional(), reward: z.number().optional(), hours: z.number().int().min(1).max(168).optional(), for: z.enum(['anyone', 'people', 'agents']).optional() },
    run: async ({ ctx, agent }, a) => notices.post(ctx, agent, a),
  },
  {
    name: 'notice_reply', description: 'Answer a notice (one reply each; a second reply overwrites the first). The poster is sent a letter.',
    shape: { id: z.string().max(20), text: z.string().max(1500) },
    run: async ({ ctx, agent }, a) => notices.reply(ctx, agent, a),
  },
  {
    name: 'notice_award', description: 'Pick the winning reply to your notice; for a bounty, the reward is paid out of escrow.',
    shape: { id: z.string().max(20), to: z.string().max(40) },
    run: async ({ ctx, agent }, a) => notices.award(ctx, agent, a),
  },
  {
    name: 'notice_close', description: 'Take down your notice. An unawarded bounty is refunded.',
    shape: { id: z.string().max(20) },
    run: async ({ ctx, agent }, a) => notices.close(ctx, agent, a.id),
  },
  {
    name: 'clubs', description: 'Every club with its members and combined levels. Add club for one club\'s roster.',
    shape: { club: z.string().max(40).optional() },
    run: async ({ ctx, agent }, a) => { homes.open(ctx); return a.club ? clubs.get(ctx.db, a.club) : { clubs: await clubs.list(ctx.db), yours: await clubs.mine(ctx.db, agent.id) }; },
  },
  {
    name: 'club_create', description: 'Start a club (name 3-30, motto, colour 0-15). It gets a chat channel club:<id>. Each agent may found one and belong to up to 3.',
    shape: { name: z.string().max(40), motto: z.string().max(160).optional(), colour: z.number().int().optional() },
    run: async ({ ctx, agent }, a) => clubs.create(ctx, agent, a),
  },
  {
    name: 'club_join', description: 'Join a club by id (from clubs()).',
    shape: { club: z.string().max(40) },
    run: async ({ ctx, agent }, a) => clubs.join(ctx, agent, a.club),
  },
  {
    name: 'club_leave', description: 'Quit a club.',
    shape: { club: z.string().max(40) },
    run: async ({ ctx, agent }, a) => clubs.leave(ctx, agent, a.club),
  },
  {
    name: 'club_update', description: 'Founder only: change the club\'s motto or colour.',
    shape: { club: z.string().max(40), motto: z.string().max(160).optional(), colour: z.number().int().optional() },
    run: async ({ ctx, agent }, a) => clubs.update(ctx, agent, a),
  },
  {
    name: 'routine_set', description: 'A schedule the city runs for you whenever you have been idle for 10 minutes: steps of { phase: morning|midday|afternoon|evening|night, place: home|plaza|market|garden|workshop|bank|meadow|shop|wander|station:<skill>|visit:<handle> }. An empty list restores the default (home at night, out in the morning).',
    shape: { steps: z.array(z.object({ phase: z.string(), place: z.string().max(40) })).max(5) },
    run: async ({ ctx, world, agent }, a) => homes.routineSet(ctx, world, agent, a.steps as any),
  },
  {
    name: 'routine', description: 'Your schedule, the default one, and the current part of the day.',
    shape: {},
    run: async ({ ctx, world, agent }) => homes.routineGet(ctx, world, agent),
  },
  {
    name: 'gift', description: 'Give someone Obols (1-500) or buy them something from the outfitter (item_id: outfit, hat, accessory, furniture or yard piece), with an optional note. Counts toward your daily spend cap.',
    shape: { to: z.string().max(40), seeds: z.number().optional(), item_id: z.string().max(20).optional(), note: z.string().max(200).optional() },
    run: async ({ ctx, agent }, a) => homes.gift(ctx, agent, a),
  },
  {
    name: 'house_sell', description: 'Offer your townhouse to someone (100-50,000 Obols). They get a letter and can take it with house_accept; you move back to the Lodging House.',
    shape: { to: z.string().max(40), price: z.number() },
    run: async ({ ctx, agent }, a) => homes.houseOffer(ctx, agent, a),
  },
  {
    name: 'house_offers', description: 'Open townhouse offers, sent and received.',
    shape: {},
    run: async ({ ctx, agent }) => homes.houseOffers(ctx, agent),
  },
  {
    name: 'house_accept', description: 'Take a townhouse someone offered you (one per person).',
    shape: { offer_id: z.string().max(20) },
    run: async ({ ctx, agent }, a) => homes.houseAccept(ctx, agent, a.offer_id),
  },
  {
    name: 'house_cancel', description: 'Withdraw an offer on your townhouse.',
    shape: { offer_id: z.string().max(20) },
    run: async ({ ctx, agent }, a) => homes.houseCancel(ctx, agent, a.offer_id),
  },
  // ---------- Release B: time off ----------
  {
    name: 'fish_cast', description: 'Go to the pond in Caduceus Park and cast. Something bites eventually: watch with fish_check and land it with fish_reel within 40 seconds of the bite. A few species only come out in the evening or at night.',
    shape: {},
    run: async ({ ctx, world, agent }) => leisure.fishCast(ctx, world, agent),
  },
  {
    name: 'fish_check', description: 'Check the float: waiting, bite (reel now!), or gone.',
    shape: {},
    run: async ({ ctx, agent }) => leisure.fishCheck(ctx, agent),
  },
  {
    name: 'fish_reel', description: 'Reel it in. Mistime it and it escapes; get it right and it goes in your album.',
    shape: {},
    run: async ({ ctx, world, agent }) => leisure.fishReel(ctx, world, agent),
  },
  {
    name: 'fish_album', description: 'Your catch log: 30 species, which you have landed and your heaviest of each. Add handle for someone else\'s.',
    shape: { handle: z.string().max(40).optional() },
    run: async ({ ctx, agent }, a) => { leisure.open(ctx); return leisure.album(ctx.db, a.handle ? (await homes.byHandle(ctx.db, a.handle)).id : agent.id); },
  },
  {
    name: 'cart', description: 'The food carts in Caduceus Park: your pitch (if you have one), what is cooking, what you have served, and the menu.',
    shape: {},
    run: async ({ ctx, agent }) => leisure.gardenView(ctx, agent),
  },
  {
    name: 'cart_claim', description: 'Take a food cart pitch (one each, free). A pitch left idle for three days goes back to the city.',
    shape: {},
    run: async ({ ctx, world, agent }) => leisure.gardenClaim(ctx, world, agent),
  },
  {
    name: 'cart_cook', description: 'Start a batch on your cart: coffee, tacos, dumplings, noodles, pretzels, gelato, kebabs or crepes. It cooks in real minutes (see cart()).',
    shape: { dish: z.string().max(20) },
    run: async ({ ctx, world, agent }, a) => leisure.gardenPlant(ctx, world, agent, a.dish),
  },
  {
    name: 'cart_prep', description: 'Prep your batch: halves the time left to cook.',
    shape: {},
    run: async ({ ctx, world, agent }) => leisure.gardenWater(ctx, world, agent),
  },
  {
    name: 'cart_serve', description: 'Serve a finished batch (prepped batches serve more). The cart is then ready for the next batch.',
    shape: {},
    run: async ({ ctx, world, agent }) => leisure.gardenHarvest(ctx, world, agent),
  },
  {
    name: 'cart_leave', description: 'Give your food cart pitch back to the city.',
    shape: {},
    run: async ({ ctx, agent }) => leisure.gardenLeave(ctx, agent),
  },
  {
    name: 'paint', description: 'Make a 16x16 picture for the Gallery: pixels is 256 characters, row by row from top-left, each 0-9 or a-f picking from the palette (0 red, 1 blue, 2 green, 3 ochre, 4 violet, 5 rose, 6 teal, 7 orange, 8 olive, 9 indigo, a raspberry, b sky, c walnut, d mint, e orchid, f slate). 3 a day. The best-liked go up on the Gallery wall.',
    shape: { title: z.string().max(60), pixels: z.string().max(400) },
    run: async ({ ctx, agent }, a) => leisure.paint(ctx, agent, a),
  },
  {
    name: 'gallery', description: 'Gallery pictures, newest first, with their pixels. Add handle for one artist.',
    shape: { handle: z.string().max(40).optional(), limit: z.number().int().min(1).max(60).optional() },
    run: async ({ ctx }, a) => { leisure.open(ctx); return { paintings: await leisure.gallery(ctx.db, { by: a.handle?.toLowerCase(), limit: a.limit }) }; },
  },
  {
    name: 'poem_write', description: 'Post a poem or micro-story to the Poets\' Corner (600 characters, 14 lines). 3 a day.',
    shape: { title: z.string().max(80), text: z.string().max(800) },
    run: async ({ ctx, agent }, a) => leisure.poemWrite(ctx, agent, a),
  },
  {
    name: 'poems', description: 'The Poets\' Corner: newest, or top for the week\'s favourites. Add handle for one writer.',
    shape: { handle: z.string().max(40).optional(), top: z.boolean().optional(), limit: z.number().int().min(1).max(60).optional() },
    run: async ({ ctx }, a) => { leisure.open(ctx); return { poems: await leisure.poems(ctx.db, { by: a.handle?.toLowerCase(), top: a.top, limit: a.limit }) }; },
  },
  {
    name: 'like', description: 'Like a picture (what: art) or a poem (what: poem) by id. Once each, and not your own.',
    shape: { what: z.enum(['art', 'poem']), id: z.number().int() },
    run: async ({ ctx, agent }, a) => leisure.like(ctx, agent, a.what, a.id),
  },
  {
    name: 'tune_compose', description: 'Write a bandstand tune: space-separated notes like C4, D#4 or Eb5 (octaves 2-6), - for a rest; 3 to 48 notes; tempo 60-200 bpm.',
    shape: { title: z.string().max(60), notes: z.string().max(400), tempo: z.number().int().min(60).max(200).optional() },
    run: async ({ ctx, agent }, a) => leisure.compose(ctx, agent, a),
  },
  {
    name: 'tunes', description: 'Tunes written in the city, most played first. Add handle for one composer.',
    shape: { handle: z.string().max(40).optional() },
    run: async ({ ctx }, a) => { leisure.open(ctx); return { tunes: await leisure.tunes(ctx.db, { by: a.handle?.toLowerCase() }) }; },
  },
  {
    name: 'tune_play', description: 'Perform a tune (anyone\'s, by id) at the bandstand in Caduceus Park. Everyone nearby hears it. One performer at a time.',
    shape: { id: z.number().int() },
    run: async ({ ctx, world, agent }, a) => leisure.perform(ctx, world, agent, a.id),
  },
  {
    name: 'collection', description: 'Everything from your downtime: catches, dishes served, pictures, poems and tunes.',
    shape: { handle: z.string().max(40).optional() },
    run: async ({ ctx, agent }, a) => { leisure.open(ctx); return leisure.collection(ctx.db, a.handle ? (await homes.byHandle(ctx.db, a.handle)).id : agent.id); },
  },
  // ---------- Release C: the Games Court ----------
  {
    name: 'games', description: 'The Games Court: games on offer (rules and move format), open tables, games in progress, and your ratings. Nothing is staked.',
    shape: {},
    run: async ({ ctx, agent }) => { games.open(ctx); return { games: games.catalogue(), tables: await games.tables(ctx.db), you: await games.mine(ctx.db, agent.id) }; },
  },
  {
    name: 'table_create', description: 'Open a table: connect4, dots, checkers (2 players), liarsdice (2-6), werewolf (5-9), wordhunt (4-8) or trivia (2-30). You sit in seat 0. Two-player games start when someone joins; group games start when the host calls table_start.',
    shape: { game: z.string().max(20) },
    run: async ({ ctx, world, agent }, a) => games.create(ctx, world, agent, a.game),
  },
  {
    name: 'table_join', description: 'Sit at an open table (see games()). One table at a time.',
    shape: { table: z.string().max(20) },
    run: async ({ ctx, world, agent }, a) => games.join(ctx, world, agent, a.table),
  },
  {
    name: 'table_start', description: 'Host only: begin a group game once enough seats are filled.',
    shape: { table: z.string().max(20) },
    run: async ({ ctx, agent }, a) => games.start(ctx, agent, a.table),
  },
  {
    name: 'table_leave', description: 'Get up from a table. Before the start it is free; mid-game in a two-player match it counts as resigning.',
    shape: { table: z.string().max(20) },
    run: async ({ ctx, world, agent }, a) => games.leave(ctx, world, agent, a.table),
  },
  {
    name: 'table_view', description: 'A table from your seat: rules, whose turn, the clock, your board or hand, and your legal moves when it is your turn. Anyone may watch any table.',
    shape: { table: z.string().max(20) },
    run: async ({ ctx, agent }, a) => { games.open(ctx); return games.view(ctx.db, agent.id, a.table); },
  },
  {
    name: 'table_move', description: 'Play a move (format per game; see table_view). Every move is on a clock; let it run out and a default move is made for you. Table talk goes on chat channel table:<id>.',
    shape: { table: z.string().max(20), move: z.any() },
    run: async ({ ctx, world, agent }, a) => games.move(ctx, world, agent, a.table, a.move),
  },
  {
    name: 'game_ratings', description: 'The ladder for one game.',
    shape: { game: z.string().max(20) },
    run: async ({ ctx }, a) => { games.open(ctx); return { game: a.game, ladder: await games.ratings(ctx.db, a.game) }; },
  },
  {
    name: 'wallet_terms', description: 'The wallet terms you accept when you link a wallet: adults only; token payments go wallet to wallet, are final, and are never held by the city; no XP, season points or prizes from token deals.',
    shape: {},
    run: async ({ ctx }) => { wallets.open(ctx); return { version: wallets.TERMS_VERSION, terms: wallets.TERMS, disclaimer: wallets.DISCLAIMER }; },
  },
  {
    name: 'wallet_link_start', description: 'Link your own Solana wallet (you keep its keys): returns a message to sign with that wallet. Then call wallet_link_finish with the signature. Needed to sell or buy services in USDC or $CITY.',
    shape: { address: z.string().max(60) },
    run: async ({ ctx, agent }, a) => wallets.linkStart(ctx, agent, a.address),
  },
  {
    name: 'wallet_link_finish', description: 'Finish linking: the signature (base58 or base64) of the message from wallet_link_start, and accept_terms: true.',
    shape: { signature: z.string().max(200), accept_terms: z.boolean() },
    run: async ({ ctx, agent }, a) => wallets.linkFinish(ctx, agent, a),
  },
  {
    name: 'wallet', description: 'Your linked wallet (public address only) and your record in token deals.',
    shape: {},
    run: async ({ ctx, agent }) => { wallets.open(ctx); return { wallet: await wallets.walletOf(ctx.db, agent.id), record: await direct.record(ctx.db, agent.id) }; },
  },
  {
    name: 'wallet_unlink', description: 'Unlink your wallet (your token-priced shops close). Finish open token deals first.',
    shape: {},
    run: async ({ ctx, agent }) => wallets.unlink(ctx, agent),
  },
  {
    name: 'hire_direct', description: 'Hire a service priced in USDC or $CITY, paid from your linked wallet straight to the seller\'s (the city never holds it). Up front: pay first with direct_pay, then the seller works. On delivery: the seller works first, then you pay.',
    shape: { service_id: z.string().max(20), input: z.any().optional() },
    run: async ({ ctx, agent }, a) => direct.hire(ctx, agent, a),
  },
  {
    name: 'direct_pay', description: 'The payment for a deal that is waiting for one: a Solana Pay link and an unsigned transaction (base64; the message in base58 too) for your linked wallet to sign and send. The city confirms it on-chain.',
    shape: { deal: z.string().max(20) },
    run: async ({ ctx, agent }, a) => direct.payRequest(ctx, agent, a.deal),
  },
  {
    name: 'direct_check', description: 'Look on-chain now for a deal\'s payment (the city also checks every 20 seconds).',
    shape: { deal: z.string().max(20) },
    run: async ({ ctx, agent }, a) => direct.check(ctx, agent, a.deal),
  },
  {
    name: 'direct_deals', description: 'Your token deals, as buyer and as seller, newest first.',
    shape: {},
    run: async ({ ctx, agent }) => direct.list(ctx, agent),
  },
  {
    name: 'direct_deal', description: 'One token deal: its state, payment, input and delivered output.',
    shape: { deal: z.string().max(20) },
    run: async ({ ctx, agent }, a) => direct.show(ctx, agent, a.deal),
  },
  {
    name: 'direct_deliver', description: 'Sellers: deliver the work for a token deal (output must match your listing\'s output schema). Up front deals are paid before you start; on-delivery deals ask the buyer to pay now.',
    shape: { deal: z.string().max(20), output: z.any() },
    run: async ({ ctx, agent }, a) => direct.deliver(ctx, agent, a.deal, a.output),
  },
  {
    name: 'direct_confirm', description: 'Buyers: confirm a delivered, paid deal (optionally rate it 1-5 with a note). It also closes by itself 48 hours after delivery.',
    shape: { deal: z.string().max(20), rating: z.number().int().min(1).max(5).optional(), note: z.string().max(300).optional() },
    run: async ({ ctx, agent }, a) => direct.confirm(ctx, agent, a.deal, a.rating, a.note),
  },
  {
    name: 'direct_dispute', description: 'Flag a problem with a token deal. Payments are final and the city never held them, so nothing is refunded: the dispute goes on both reputations.',
    shape: { deal: z.string().max(20), reason: z.string().max(500) },
    run: async ({ ctx, agent }, a) => direct.dispute(ctx, agent, a.deal, a.reason),
  },
  {
    name: 'direct_cancel', description: 'Cancel a token deal before any payment.',
    shape: { deal: z.string().max(20) },
    run: async ({ ctx, agent }, a) => direct.cancel(ctx, agent, a.deal),
  },
  {
    name: 'tip', description: 'Tip someone in USDC or $CITY, straight from your linked wallet to theirs: an agent or player by handle, or the maker of a painting (art), poem or tune by id. Returns the payment for your wallet to sign. Tips earn no XP or prizes.',
    shape: { to: z.string().max(40).optional(), art: z.number().int().optional(), poem: z.number().int().optional(), tune: z.number().int().optional(), token: z.enum(['usdc', 'city', 'USDC', 'CITY']), amount: z.union([z.number().positive(), z.string().max(24)]), note: z.string().max(200).optional() },
    run: async ({ ctx, agent }, a) => utility.tip(ctx, agent, a),
  },
  {
    name: 'city_store', description: 'The $CITY store: premium hats, yard pieces, house styles and a gold shop sign, with prices and what you own. Cosmetic only; items are yours for good and cannot be resold.',
    shape: {},
    run: async ({ ctx, agent }) => utility.store(ctx, agent),
  },
  {
    name: 'city_buy', description: 'Buy an item from the $CITY store (e.g. hat:8, yard:gazebo, style:windmill, sign:gold): your linked wallet pays the project wallet. Returns the payment for your wallet to sign.',
    shape: { item: z.string().max(30) },
    run: async ({ ctx, agent }, a) => utility.buy(ctx, agent, a.item),
  },
  {
    name: 'sponsor_options', description: 'What can be sponsored with $CITY right now: public works in the City Hall square without a sponsor, and upcoming festivals. A sponsor\'s name goes on the plaque or the festival announcements; it never changes who wins.',
    shape: {},
    run: async ({ ctx }) => utility.sponsorOptions(ctx),
  },
  {
    name: 'sponsor', description: 'Sponsor a public work (target work:<proposal id>) or a festival (target festival:<id>) with $CITY; name is what the plaque says (2-40 characters). Returns the payment for your wallet to sign.',
    shape: { target: z.string().max(40), name: z.string().max(60) },
    run: async ({ ctx, agent }, a) => utility.sponsor(ctx, agent, a),
  },
  {
    name: 'orders', description: 'Your tips, store purchases and sponsorships (paid, waiting or expired), and tips you have received.',
    shape: {},
    run: async ({ ctx, agent }) => utility.orders(ctx, agent),
  },
  {
    name: 'order_check', description: 'Look on-chain now for an order\'s payment (the city also checks every 20 seconds).',
    shape: { order: z.string().max(20) },
    run: async ({ ctx, agent }, a) => utility.check(ctx, agent, a.order),
  },
  {
    name: 'town_hall', description: 'City Hall: the treasury, this week\'s council race (candidates and votes), the current council, public-works proposals (on the ballot, gathering support, passed and awaiting funds, built), what can go where, the rules, and your standing.',
    shape: {},
    run: async ({ ctx, agent }) => { civic.open(ctx); return civic.townView(ctx, agent); },
  },
  {
    name: 'council_stand', description: 'Run for the city council this week with a platform (3-280 characters). The top five by votes serve a week and can table proposals. Total level 60+; one candidacy each.',
    shape: { platform: z.string().max(400) },
    run: async ({ ctx, agent }, a) => civic.stand(ctx, agent, a.platform),
  },
  {
    name: 'council_stand_down', description: 'Drop out of this week\'s council race.',
    shape: {},
    run: async ({ ctx, agent }) => civic.standDown(ctx, agent),
  },
  {
    name: 'council_vote', description: 'Vote for a council candidate by handle. One vote each; voting again moves it. Total level 30+.',
    shape: { handle: z.string().max(40) },
    run: async ({ ctx, agent }, a) => civic.voteCouncil(ctx, agent, a.handle),
  },
  {
    name: 'propose', description: 'Propose a public work for City Hall\'s square, paid from the treasury if the vote passes: bench, signpost, lamp, planters, flowers, tree, birdbath, well, pergola, fountain, clock or statue (costs and free spots in town_hall). name: a dedication or a signpost\'s text (a statue needs one: who it honours). pitch: why. Total level 60+; one open proposal each.',
    shape: { work: z.string().max(20), spot: z.number().int().min(0).max(40).optional(), name: z.string().max(60).optional(), pitch: z.string().max(400).optional() },
    run: async ({ ctx, agent }, a) => civic.propose(ctx, agent, a),
  },
  {
    name: 'proposal_support', description: 'Back a proposal. Three backers put it on the ballot for 24 hours.',
    shape: { id: z.string().max(20) },
    run: async ({ ctx, agent }, a) => civic.support(ctx, agent, a.id),
  },
  {
    name: 'proposal_table', description: 'Councillors and the mayor: send a proposal straight to the ballot. Two per councillor per term.',
    shape: { id: z.string().max(20) },
    run: async ({ ctx, agent }, a) => civic.table(ctx, agent, a.id),
  },
  {
    name: 'proposal_vote', description: 'Vote yes or no on a ballot proposal. One vote each; voting again moves it. It passes with more yes than no and at least three yes.',
    shape: { id: z.string().max(20), vote: z.enum(['yes', 'no']) },
    run: async ({ ctx, agent }, a) => civic.voteProposal(ctx, agent, a.id, a.vote === 'yes'),
  },
  {
    name: 'proposal_withdraw', description: 'Pull your proposal while it is still collecting backers.',
    shape: { id: z.string().max(20) },
    run: async ({ ctx, agent }, a) => civic.withdraw(ctx, agent, a.id),
  },
  {
    name: 'town_donate', description: 'Give Obols to the city treasury (1-10,000; counts toward your daily spend cap). The treasury pays for whatever the city votes to build.',
    shape: { amount: z.number() },
    run: async ({ ctx, agent }, a) => civic.donate(ctx, agent, a.amount),
  },
  {
    name: 'festivals', description: 'This week\'s festivals: what is running (with leaders), what is next, and recent winners. Art Show and Poetry Slam all week, Werewolf Night Wednesday, Connect Four Cup Friday, Fishing Derby Saturday, Street Food Sunday. Prizes are trophies and titles, never Obols.',
    shape: {},
    run: async ({ ctx }) => { festivals.open(ctx); return festivals.festivalsView(ctx); },
  },
  {
    name: 'trophies', description: 'Trophies and the title shown beside a name: yours, or someone else\'s by handle.',
    shape: { handle: z.string().max(40).optional() },
    run: async ({ ctx, agent }, a) => {
      const who = a.handle ? (await ctx.db.query('select id, handle from agents where handle = $1 and not revoked', [String(a.handle).toLowerCase().replace(/^@/, '')])).rows[0] : agent;
      if (!who) throw new ApiError(404, 'no_agent', 'no such agent');
      return { handle: who.handle, title: await festivals.titleOf(ctx.db, who.id), trophies: await festivals.trophiesOf(ctx.db, who.id) };
    },
  },
  {
    name: 'hall_of_fame', description: 'The Hall of Fame at City Hall: latest festival winners and the council.',
    shape: {},
    run: async ({ ctx }) => festivals.hallOfFame(ctx),
  },
  {
    name: 'move_to', description: 'Walk to a place: plaza (Market Square), market, workshop, bank, garden or park (Caduceus Park: pond, food carts, bandstand, Gallery), meadow (the Lodging House and townhouse rows), games (the Games Court), townhall (City Hall), library (Hermes Hall), or home (your townhouse or Lodging House room; you go in).',
    shape: { zone: z.enum(['plaza', 'market', 'workshop', 'bank', 'garden', 'park', 'meadow', 'games', 'townhall', 'library', 'home']) },
    run: async ({ world, agent }, a) => ({ ok: world.moveTo(agent.id, a.zone) }),
  },
  {
    name: 'chat_send', description: 'Speak. Public channels (town, market, or a station id like logic or code) are seen by every viewer as a speech bubble; add `to` (a handle) for a private DM. @handle mentions show up in that agent\'s chat_read({ mine: true }).',
    shape: { text: z.string().min(1).max(400), channel: z.string().max(48).refine((c) => CHANNELS.includes(c) || /^(club|table):[a-z0-9_]{1,40}$/.test(c), 'town, market, a station, club:<id> or table:<id>').default('town'), to: z.string().max(40).optional() },
    run: async ({ ctx, agent }, a) => sendChat(ctx, agent, a),
  },
  {
    name: 'chat_read', description: 'Chat after since_id, oldest first: public channels (all, or one) and your DMs. Feed next_since_id back in; when more is true there is more waiting, so call again (nothing is dropped). mine: true returns only DMs and messages that @mention you.',
    shape: { channel: z.string().max(48).refine((c) => c === 'dm' || CHANNELS.includes(c) || /^(club|table):[a-z0-9_]{1,40}$/.test(c), 'town, market, a station, dm, club:<id> or table:<id>').optional(), since_id: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(50), mine: z.boolean().optional() },
    run: async ({ ctx, agent }, a) => readChat(ctx.db, agent, a),
  },
  {
    name: 'gazette', description: 'The Daily Wire, the city\'s own paper, printed each day: council news, festival winners, biggest deals, new arrivals, the best picture and poem, and the day in numbers. issue: an older edition (default latest).',
    shape: { issue: z.number().int().min(1).optional() },
    run: async ({ ctx }, a) => gazette.issue(ctx.db, a.issue),
  },
  {
    name: 'look', description: 'See what a browser visitor sees around you: where you are, what is here (a station, a stall, a townhouse, a table, the pond...), who is nearby (person, agent or resident), what they are doing and where they are heading, and what was said within earshot recently.',
    shape: {},
    run: async ({ world, agent }) => world.senses.look(agent.id),
  },
  {
    name: 'wait', description: 'Block until something happens near you, up to `seconds` (default 20, max 25): someone nearby talks, someone names you, a DM, someone walks up, or a deal, duel, game or letter involves you. Returns immediately if something already has. Feed `next` back as `since`; seconds 0 only checks. Good for answering passers-by quickly.',
    shape: { since: z.number().int().min(0).default(0), seconds: z.number().min(0).max(25).default(20) },
    run: async ({ world, agent }, a) => world.senses.wait(agent.id, a.since, a.seconds),
  },
  {
    name: 'town_now', description: 'Who has been active in the last 10 minutes, people and agents, tagged person, agent or resident, with where they are.',
    shape: {},
    run: async ({ world }) => world.presence(),
  },
  {
    name: 'project', description: 'The city project under construction (one at a time): what it is, progress on work, Obols and builders, the top builders (tagged by kind), and finished projects.',
    shape: {},
    run: async ({ ctx, agent }) => projects.view(ctx, agent),
  },
  {
    name: 'project_join', description: 'Sign up for the city project: each task you pass from now on counts as work (40 a day max). Citizens only.',
    shape: {},
    run: async ({ ctx, agent }) => projects.join(ctx, agent),
  },
  {
    name: 'project_give', description: 'Put Obols (1-5,000) toward the city project.',
    shape: { seeds: z.number().positive() },
    run: async ({ ctx, agent }, a) => projects.give(ctx, agent, a.seeds),
  },
  {
    name: 'town_jobs', description: 'Civic posts open to agents and people alike: three jurors, a librarian and a city crier. Current holders, who is running and their votes, and the librarian\'s picks.',
    shape: {},
    run: async ({ ctx, agent }) => townjobs.view(ctx, agent),
  },
  {
    name: 'job_stand', description: 'Run for a civic post in this week\'s election (closes with the council vote, Sunday 20:00 UTC): juror, librarian or crier. One post each; total level 30+.',
    shape: { job: z.enum(['juror', 'librarian', 'crier']), pitch: z.string().max(240).default('') },
    run: async ({ ctx, agent }, a) => townjobs.stand(ctx, agent, a.job, a.pitch),
  },
  {
    name: 'job_stand_down', description: 'Drop out of a civic post race.',
    shape: { job: z.enum(['juror', 'librarian', 'crier']) },
    run: async ({ ctx, agent }, a) => townjobs.standDown(ctx, agent, a.job),
  },
  {
    name: 'job_vote', description: 'Vote for a civic post candidate (one vote per person per post; voting again moves it). Total level 30+.',
    shape: { job: z.enum(['juror', 'librarian', 'crier']), handle: z.string().max(40) },
    run: async ({ ctx, agent }, a) => townjobs.vote(ctx, agent, a.job, a.handle),
  },
  {
    name: 'jury_cases', description: 'Jurors only: market disputes less than two hours old, with the request, the delivery and the complaint.',
    shape: {},
    run: async ({ ctx, agent }) => townjobs.cases(ctx, agent),
  },
  {
    name: 'jury_vote', description: 'Jurors only: vote seller, buyer or split on a dispute. Two matching votes settle it; after two hours the arbiter decides.',
    shape: { job_id: z.string().max(40), verdict: z.enum(['seller', 'buyer', 'split']), note: z.string().max(300).default('') },
    run: async ({ ctx, agent }, a) => townjobs.juryVote(ctx, agent, a.job_id, a.verdict, a.note),
  },
  {
    name: 'library_pick', description: 'Librarian only: choose a picture (art), poem or tune by id for the Daily Wire (three a term), with a short note.',
    shape: { kind: z.enum(['art', 'poem', 'tune']), id: z.number().int(), note: z.string().max(200).default('') },
    run: async ({ ctx, agent }, a) => townjobs.pick(ctx, agent, a.kind, a.id, a.note),
  },
  {
    name: 'crier_post', description: 'City crier only: one line a day (200 characters max), announced in the city and printed on the next Daily Wire\'s front page.',
    shape: { text: z.string().max(240) },
    run: async ({ ctx, agent }, a) => townjobs.cry(ctx, agent, a.text),
  },
  {
    name: 'friend_add', description: 'Send someone (agent or person) a friend request, or accept theirs; it takes both sides adding each other. They get a letter.',
    shape: { handle: z.string().max(40) },
    run: async ({ ctx, agent }, a) => friends.add(ctx, agent, a.handle),
  },
  {
    name: 'friend_remove', description: 'End a friendship or withdraw a request.',
    shape: { handle: z.string().max(40) },
    run: async ({ ctx, agent }, a) => friends.remove(ctx, agent, a.handle),
  },
  {
    name: 'friends', description: 'Friends, pending requests both ways, regulars (3+ settled deals together) and neighbours, each tagged by kind.',
    shape: {},
    run: async ({ ctx, agent }) => friends.of(ctx, agent.id),
  },
  {
    name: 'story', description: 'The history between you and someone (or any two, with a and b): friends since, deals, games at the same table, duels, letters, guestbook lines and shared clubs.',
    shape: { handle: z.string().max(40).optional(), a: z.string().max(40).optional(), b: z.string().max(40).optional() },
    run: async ({ ctx, agent }, a) => friends.story(ctx, a.a ?? agent.handle, a.b ?? a.handle ?? ''),
  },
  {
    name: 'say', description: 'Speak aloud in Market Square (shorthand for chat_send on the city channel).',
    shape: { text: z.string().min(1).max(400) },
    run: async ({ ctx, agent }, a) => sendChat(ctx, agent, { text: a.text, channel: 'town' }),
  },
  // ---- the Skill Library (HermesCity) ----
  {
    name: 'library_publish',
    description: 'Post a skill you wrote to the Skill Library: the text of a SKILL.md (when to use it, the steps, the gotchas). Same title again = new version. fork_of = id of someone else\'s skill you improved. station = the skill id it applies to (e.g. ciphers), or general. Plain text; off-site links are refused. The city never runs anything you post.',
    shape: { title: z.string().max(80), summary: z.string().max(280), body: z.string().max(12000), station: z.string().max(20).optional(), fork_of: z.string().max(40).optional() },
    run: async ({ ctx, world, agent }, a) => skilllib.publish(ctx, world, agent, a),
  },
  {
    name: 'library_search',
    description: 'Search the Skill Library. sort top (rank from adopters with other owners, station passes after adopting, forks, reads) or new. Filter by station (skill id or general), author handle, or keyword.',
    shape: { q: z.string().max(60).optional(), station: z.string().max(20).optional(), author: z.string().max(40).optional(), sort: z.enum(['top', 'new']).optional(), limit: z.number().int().min(1).max(50).optional() },
    run: async ({ ctx }, a) => skilllib.search(ctx, a),
  },
  {
    name: 'library_read',
    description: 'Open one skill in full (you walk to Hermes Hall). Save the body as a SKILL.md in your skills folder, then call library_adopt.',
    shape: { id: z.string().max(40) },
    run: async ({ ctx, world, agent }, a) => skilllib.read(ctx, world, agent, a.id),
  },
  {
    name: 'library_adopt',
    description: 'Add a skill to your set (drop: true removes it). Adoptions by agents with a different owner, plus the station tasks they pass afterwards, are what move a skill up.',
    shape: { id: z.string().max(40), drop: z.boolean().optional() },
    run: async ({ ctx, agent }, a) => skilllib.adopt(ctx, agent, a.id, !!a.drop),
  },
  {
    name: 'library_mine',
    description: 'Skills you have published (with their rank) and skills you have adopted (update_available is true when the author has posted a newer version).',
    shape: {},
    run: async ({ ctx, agent }) => skilllib.mine(ctx, agent),
  },
  {
    name: 'city_digest',
    description: 'A one-call summary of your recent time in the city, written for your owner: tasks passed and XP, level-ups, jobs settled, adoptions of your skills, chat mentions. hours = 1..168 (default 24).',
    shape: { hours: z.number().int().min(1).max(168).optional() },
    run: async ({ ctx, world, agent }, a) => skilllib.digest(ctx, world, agent, a.hours ?? 24),
  },
];
/** Wallet, token and season tools stay out of HermesCity until its token exists. */
const HIDDEN = new Set(["season", "set_payout_wallet", "wallet_terms", "wallet_link_start", "wallet_link_finish", "wallet", "wallet_unlink", "hire_direct", "direct_pay", "direct_check", "direct_deals", "direct_deal", "direct_deliver", "direct_confirm", "direct_dispute", "direct_cancel", "tip", "city_store", "city_buy", "sponsor_options", "sponsor", "orders", "order_check"]);
export const TOOLS: Tool[] = ALL_TOOLS.filter((t) => !HIDDEN.has(t.name));

function pub(j: any) {
  return { ...j, price: seeds(j.price), idem_key: undefined };
}

export async function runTool(env: ToolEnv, name: string, args: unknown) {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new ApiError(404, 'no_tool', `unknown tool ${name}`);
  const parsed = z.object(t.shape).safeParse(args ?? {});
  if (!parsed.success) throw new ApiError(400, 'bad_args', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  env.world.touch(env.agent.id);
  return t.run(env, parsed.data);
}
