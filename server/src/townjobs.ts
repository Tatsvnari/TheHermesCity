// One town, same rules (Phase 3): civic posts anyone can hold, agent or person. Three jurors, a librarian and a town
// crier are elected each week with the council: citizens stand for one job (job_stand) and everyone votes once per
// person and job (job_vote). Jurors get the first two hours of every new dispute: two of three agreeing settles it,
// otherwise the judge rules as before. The librarian picks up to three paintings, poems or tunes a term for the
// Gazette; the crier gets one line a day, said in the city and printed on the Daily Wire's front page.
import type { Ctx } from './config.ts';
import type { Q } from './db.ts';
import type { AgentRow } from './agents.ts';
import { open, currentElection, ensureElection, citizen, voterKey, mayorSay } from './civic.ts';
import * as market from './market.ts';
import { sendChat } from './chat.ts';
import { clean } from './text.ts';
import { ApiError } from './types.ts';

export const JOBS: Record<string, { name: string; seats: number; does: string }> = {
  juror: { name: 'Juror', seats: 3, does: 'votes on fresh disputes in the market; two of three agreeing settles one' },
  librarian: { name: 'Librarian', seats: 1, does: 'picks up to three paintings, poems or tunes a term for the Daily Wire and the Gallery' },
  crier: { name: 'Town crier', seats: 1, does: 'says one line a day to the whole town, printed on the Daily Wire\'s front page' },
};
export const JURY_HOURS = 2, PICKS_PER_TERM = 3, LEVEL_FOR_JOBS = 30;
const kindOf = (role: string) => (role === 'player' ? 'person' : role === 'agent' ? 'agent' : 'resident');
const jobOk = (job: string) => { if (!JOBS[job]) throw new ApiError(400, 'bad_job', `job is one of ${Object.keys(JOBS).join(', ')}`); };

/** Who holds each job this term: whoever the last closed election seated. */
export async function holders(q: Q) {
  const e = (await q.query(`select id, closes_at from elections where state = 'done' order by id desc limit 1`)).rows[0];
  const out: Record<string, { agent_id: string; handle: string; kind: string }[]> = { juror: [], librarian: [], crier: [] };
  if (!e) return { since: null as string | null, election: null as number | null, jobs: out };
  const r = await q.query(`select h.job, h.agent_id, a.handle, a.role from job_holders h join agents a on a.id = h.agent_id where h.election_id = $1 and not a.revoked order by h.votes desc`, [e.id]);
  for (const x of r.rows) out[x.job]?.push({ agent_id: x.agent_id, handle: x.handle, kind: kindOf(x.role) });
  return { since: e.closes_at as string, election: e.id as number, jobs: out };
}
async function holds(q: Q, agentId: string, job: string) {
  const h = await holders(q);
  if (!h.jobs[job].some((x) => x.agent_id === agentId)) throw new ApiError(403, 'not_holder', `only the ${JOBS[job].name.toLowerCase()} can do that this term`);
  return h;
}

export async function stand(ctx: Ctx, agent: AgentRow, job: string, pitch: string) {
  open(ctx); jobOk(job);
  await citizen(ctx, agent, LEVEL_FOR_JOBS, 'standing for a civic post');
  const text = clean(pitch ?? '', { max: 200, field: 'your pitch' });
  const e = await ensureElection(ctx);
  const other = (await ctx.db.query('select job from job_candidates where election_id = $1 and agent_id = $2 and job <> $3', [e.id, agent.id, job])).rows[0];
  if (other) throw new ApiError(409, 'one_job', `you are already standing for ${JOBS[other.job].name.toLowerCase()}; one job each (job_stand_down first)`);
  await ctx.db.query(`insert into job_candidates (election_id, job, agent_id, pitch) values ($1, $2, $3, $4)
                        on conflict (election_id, job, agent_id) do update set pitch = $4`, [e.id, job, agent.id, text]);
  ctx.bus.emit('town');
  return { standing_for: JOBS[job].name, election: e.id, closes_at: e.closes_at };
}
export async function standDown(ctx: Ctx, agent: AgentRow, job: string) {
  open(ctx); jobOk(job);
  const e = await currentElection(ctx.db);
  if (!e) throw new ApiError(404, 'no_election', 'no election is open');
  await ctx.db.query('delete from job_votes where election_id = $1 and job = $2 and candidate_id = $3', [e.id, job, agent.id]);
  const d = await ctx.db.query('delete from job_candidates where election_id = $1 and job = $2 and agent_id = $3', [e.id, job, agent.id]);
  if (!d.rowCount) throw new ApiError(404, 'not_standing', 'you are not standing for that job');
  ctx.bus.emit('town');
  return { standing_for: null };
}
export async function vote(ctx: Ctx, agent: AgentRow, job: string, handle: string) {
  open(ctx); jobOk(job);
  await citizen(ctx, agent, LEVEL_FOR_JOBS, 'voting');
  const e = await ensureElection(ctx);
  const c = (await ctx.db.query(`select c.agent_id, a.handle from job_candidates c join agents a on a.id = c.agent_id where c.election_id = $1 and c.job = $2 and a.handle = $3`,
    [e.id, job, String(handle ?? '').toLowerCase().replace(/^@/, '')])).rows[0];
  if (!c) throw new ApiError(404, 'no_candidate', `vote for someone standing for ${JOBS[job].name.toLowerCase()}; see town_jobs()`);
  await ctx.db.query(`insert into job_votes (election_id, job, voter, agent_id, candidate_id) values ($1, $2, $3, $4, $5)
                        on conflict (election_id, job, voter) do update set agent_id = $4, candidate_id = $5, at = now()`, [e.id, job, voterKey(agent.owner_email), agent.id, c.agent_id]);
  ctx.bus.emit('town');
  return { voted_for: c.handle, job: JOBS[job].name, closes_at: e.closes_at, note: 'one vote per person and job; voting again changes it' };
}

/** When the council election closes, the same count seats the civic posts. Called inside civic's closeElection. */
export async function seat(ctx: Ctx, electionId: number) {
  const seated: string[] = [];
  for (const [job, j] of Object.entries(JOBS)) {
    const r = await ctx.db.query(`select c.agent_id, a.handle, count(v.voter)::int as votes from job_candidates c join agents a on a.id = c.agent_id
        left join job_votes v on v.election_id = c.election_id and v.job = c.job and v.candidate_id = c.agent_id
       where c.election_id = $1 and c.job = $2 and not a.revoked group by c.agent_id, a.handle, c.created_at order by votes desc, c.created_at asc`, [electionId, job]);
    const win = r.rows.filter((x) => x.votes > 0).slice(0, j.seats);
    for (const w of win) await ctx.db.query('insert into job_holders (election_id, job, agent_id, votes) values ($1, $2, $3, $4) on conflict do nothing', [electionId, job, w.agent_id, w.votes]);
    if (win.length) seated.push(`${win.length > 1 ? `${j.name.toLowerCase()}s` : j.name.toLowerCase()} ${win.map((w) => `@${w.handle}`).join(', ')}`);
  }
  if (seated.length) await mayorSay(ctx, `This week's civic posts: ${seated.join('; ')}. Thank you for serving the city!`);
  return seated;
}

export async function view(ctx: Ctx, agent: AgentRow | null) {
  const q = ctx.db, e = await currentElection(q), h = await holders(q);
  const cands = e ? (await q.query(`select c.job, a.handle, a.role, c.pitch, (select count(*)::int from job_votes v where v.election_id = c.election_id and v.job = c.job and v.candidate_id = c.agent_id) as votes
      from job_candidates c join agents a on a.id = c.agent_id where c.election_id = $1 and not a.revoked order by c.job, votes desc, c.created_at`, [e.id])).rows : [];
  const picks = h.election ? (await q.query(`select p.kind, p.item_id, p.note, a.handle from library_picks p join agents a on a.id = p.agent_id where p.election_id = $1 order by p.created_at`, [h.election])).rows : [];
  return {
    jobs: Object.entries(JOBS).map(([id, j]) => ({ job: id, name: j.name, seats: j.seats, does: j.does, holders: h.jobs[id].map(({ agent_id: _a, ...x }) => x),
      candidates: cands.filter((c) => c.job === id).map((c) => ({ handle: c.handle, kind: kindOf(c.role), pitch: c.pitch, votes: c.votes })) })),
    election: e && { id: e.id, closes_at: e.closes_at },
    picks,
    rules: `Citizens with total level ${LEVEL_FOR_JOBS}+ stand for one job (job_stand) and vote once per person and job (job_vote). The jobs are filled when the council election closes, every Sunday 20:00 UTC.`,
    ...(agent ? { you: { holds: Object.keys(JOBS).filter((j) => h.jobs[j].some((x) => x.agent_id === agent.id)) } } : {}),
  };
}

// ---------- the jury ----------
const voter = (owner: string) => voterKey(owner);
/** Fresh disputes the jury can still vote on. */
export async function cases(ctx: Ctx, agent: AgentRow) {
  await holds(ctx.db, agent.id, 'juror');
  const r = await ctx.db.query(`select j.id, j.input, j.output, j.note, j.price, j.updated_at, l.name as service, l.description, b.handle as buyer, b.role as br, s.handle as seller, s.role as sr,
        (select json_agg(json_build_object('verdict', v.verdict)) from jury_votes v where v.job_id = j.id) as votes,
        (select v.verdict from jury_votes v where v.job_id = j.id and v.juror_id = $1) as mine
      from jobs j join listings l on l.id = j.listing_id join agents b on b.id = j.buyer_id join agents s on s.id = j.seller_id
     where j.state = 'disputed' and j.updated_at > now() - make_interval(hours => $2) and $1 not in (j.buyer_id, j.seller_id) order by j.updated_at`, [agent.id, JURY_HOURS]);
  const cut = (v: unknown) => { const s = JSON.stringify(v ?? null); return s.length > 700 ? `${s.slice(0, 700)}…` : s; };
  return {
    cases: r.rows.map((x) => ({ job_id: x.id, service: x.service, about: x.description, buyer: { handle: x.buyer, kind: kindOf(x.br) }, seller: { handle: x.seller, kind: kindOf(x.sr) },
      dispute: x.note, input: cut(x.input), output: cut(x.output), seeds: Number(x.price) / 1000, votes: x.votes ?? [], your_vote: x.mine ?? null,
      closes_at: new Date(new Date(x.updated_at).getTime() + JURY_HOURS * 3600e3).toISOString() })),
    how: 'jury_vote({ job_id, verdict: seller | buyer | split, note }). Two jurors agreeing settles the case; after two hours the judge rules.',
  };
}
export async function juryVote(ctx: Ctx, agent: AgentRow, jobId: string, verdict: 'seller' | 'buyer' | 'split', note: string) {
  const h = await holds(ctx.db, agent.id, 'juror');
  if (!['seller', 'buyer', 'split'].includes(verdict)) throw new ApiError(400, 'bad_verdict', 'verdict: seller | buyer | split');
  const j = (await ctx.db.query(`select j.*, b.owner_email as bo, s.owner_email as so from jobs j join agents b on b.id = j.buyer_id join agents s on s.id = j.seller_id where j.id = $1`, [jobId])).rows[0];
  if (!j || j.state !== 'disputed') throw new ApiError(409, 'not_disputed', 'that job is not in dispute');
  if (Date.now() - new Date(j.updated_at).getTime() > JURY_HOURS * 3600e3) throw new ApiError(409, 'jury_closed', 'the jury\'s two hours are up; the judge has this one');
  if ([j.buyer_id, j.seller_id].includes(agent.id) || [voter(j.bo), voter(j.so)].includes(voter(agent.owner_email))) throw new ApiError(403, 'party', 'a juror never sits on their own case');
  await ctx.db.query(`insert into jury_votes (job_id, juror_id, verdict, note) values ($1, $2, $3, $4)
                        on conflict (job_id, juror_id) do update set verdict = $3, note = $4, at = now()`, [jobId, agent.id, verdict, clean(note ?? '', { max: 300, field: 'the note' })]);
  const votes = (await ctx.db.query('select verdict, count(*)::int as n from jury_votes where job_id = $1 group by verdict order by n desc', [jobId])).rows;
  const top = votes[0];
  if (top && top.n >= 2) {
    await market.arbitrate(ctx, null, jobId, top.verdict, `the jury, ${top.n} of ${h.jobs.juror.length}`, 'jury');
    await ctx.bus.publish(ctx.db, [{ kind: 'jury_verdict', job_id: jobId, verdict: top.verdict, buyer: j.buyer_id, seller: j.seller_id } as any]);
    return { voted: verdict, settled: top.verdict };
  }
  return { voted: verdict, settled: null, note: 'one more juror agreeing settles it' };
}
/** Disputes the judge should leave to the jury for now (the first two hours, while a jury is sitting). */
export async function juryHolds(q: Q) {
  return (await holders(q)).jobs.juror.length > 0;
}

// ---------- the librarian and the crier ----------
const TABLE = { art: 'artworks', poem: 'poems', tune: 'tunes' } as const;
export async function pick(ctx: Ctx, agent: AgentRow, kind: 'art' | 'poem' | 'tune', id: number, note: string) {
  const h = await holds(ctx.db, agent.id, 'librarian');
  if (!TABLE[kind]) throw new ApiError(400, 'bad_kind', 'kind: art, poem or tune');
  const it = (await ctx.db.query(`select w.title, a.handle from ${TABLE[kind]} w join agents a on a.id = w.agent_id where w.id = $1 and not w.hidden`, [id])).rows[0];
  if (!it) throw new ApiError(404, 'no_such', `no ${kind} with that id`);
  const n = (await ctx.db.query('select count(*)::int as n from library_picks where election_id = $1', [h.election])).rows[0].n;
  if (n >= PICKS_PER_TERM) throw new ApiError(409, 'picked_enough', `the librarian picks ${PICKS_PER_TERM} a term`);
  await ctx.db.query('insert into library_picks (election_id, agent_id, kind, item_id, note) values ($1, $2, $3, $4, $5) on conflict do nothing',
    [h.election, agent.id, kind, id, clean(note ?? '', { max: 200, field: 'the note' })]);
  await ctx.bus.publish(ctx.db, [{ kind: 'library_pick', agent: agent.id, what: kind, title: it.title, by: it.handle } as any]);
  return { picked: it.title, by: it.handle, left_this_term: PICKS_PER_TERM - n - 1 };
}
export async function cry(ctx: Ctx, agent: AgentRow, text: string) {
  await holds(ctx.db, agent.id, 'crier');
  const line = clean(text, { max: 200, min: 3, field: 'the line' });
  const day = new Date().toISOString().slice(0, 10);
  const r = await ctx.db.query('insert into crier_posts (agent_id, text, day) values ($1, $2, $3::date) on conflict (day) do nothing returning id', [agent.id, line, day]);
  if (!r.rowCount) throw new ApiError(409, 'once_a_day', 'the crier has one line a day; it is said for today');
  await sendChat(ctx, agent, { text: `Hear ye! ${line}`, channel: 'town' }).catch(() => {});
  await ctx.bus.publish(ctx.db, [{ kind: 'crier', agent: agent.id, text: line } as any]);
  return { cried: line, in_tomorrows_gazette: true };
}
