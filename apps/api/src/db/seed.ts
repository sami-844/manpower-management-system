/**
 * Fictional data for development and demos. Never put real worker data here (CLAUDE.md).
 * Deterministic: the same seed always produces the same people.
 */
import { addDays, ORGANISATION_DOCUMENT_TYPES, type CalendarDate, type OrganisationDocumentType } from "@mms/core";
import { omanClock } from "../common/clock";
import { createDatabase, type Database } from "./client";
import { sites, workerDocuments, workers } from "./schema";

let state = 20261014;
const rand = () => {
  state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
  return state / 2_147_483_648;
};
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));

const FIRST = ["Rahim", "Karim", "Suresh", "Anil", "Bikash", "Imran", "Ravi", "Hasan", "Joseph", "Manoj", "Sabbir", "Arjun", "Faisal", "Ramesh", "Dipak", "Nasir", "Vinod", "Shakil", "Pradeep", "Asif"];
const LAST = ["Uddin", "Hossain", "Kumar", "Thapa", "Khan", "Rana", "Pillai", "Mia", "Nair", "Gurung", "Ahmed", "Islam", "Singh", "Shrestha", "Rahman", "Menon", "Ali", "Das", "Tamang", "Iqbal"];
const COUNTRIES = ["Bangladesh", "India", "Nepal", "Pakistan"];
const TRADES = ["General labourer", "Mason", "Carpenter", "Steel fixer", "Electrician", "Plumber", "Scaffolder", "Welder", "Equipment operator", "Driver"];

async function seed() {
  const url = process.env.DATABASE_URL ?? "postgres://mms:mms@localhost:5432/mms_dev";
  if (url.includes("prod")) throw new Error("Refusing to seed a production database");
  const db = createDatabase(url);
  const today = omanClock.today();
  const count = Number(process.env.SEED_WORKERS ?? 120);
  if (process.argv.includes("--masters-only")) {
    await seedMasters(db, today);
    await db.sql.end();
    return;
  }

  await db.orm.insert(sites).values([
    { code: "SOH-PORT", name: "Sohar Port Phase 3", clientName: "Gulf Build LLC", requiredDocuments: ["sohar_gate_pass"] },
    { code: "MCT-TWR", name: "Muscat Tower Block B", clientName: "Al Noor Contracting", requiredDocuments: ["trade_certificate"] },
    { code: "SOH-IND", name: "Sohar Industrial Yard", clientName: "Batinah Steel", requiredDocuments: ["driving_licence"] },
  ]).onConflictDoNothing();

  for (let i = 0; i < count; i++) {
    const [w] = await db.orm
      .insert(workers)
      .values({
        fullName: `${pick(FIRST)} ${pick(LAST)}`,
        nationality: pick(COUNTRIES),
        trade: pick(TRADES),
        // Roughly a healthy labour-supply mix: ~86% deployed, ~8% on the bench, ~6% on leave.
        status: rand() < 0.86 ? "deployed" : rand() < 0.6 ? "available" : "on_leave",
        phone: `+968 9${int(1000000, 9999999)}`,
        joinedOn: addDays(today, -int(30, 2000)),
      })
      .returning();

    // Most workers are in order; some are expiring, a few expired or missing papers.
    const roll = rand();
    const baseExpiry = (offset: number) => addDays(today, offset + int(0, 400));
    const docs: (typeof workerDocuments.$inferInsert)[] = [
      { workerId: w!.id, type: "passport", number: `P${int(1000000, 9999999)}`, expiryDate: baseExpiry(500), verified: true },
      { workerId: w!.id, type: "residence_visa", number: `RV${int(100000, 999999)}`, expiryDate: roll < 0.12 ? addDays(today, int(1, 85)) : roll < 0.17 ? addDays(today, -int(1, 40)) : baseExpiry(120), verified: true },
      { workerId: w!.id, type: "labour_card", number: `LC${int(100000, 999999)}`, expiryDate: roll > 0.9 ? addDays(today, int(1, 60)) : baseExpiry(150), verified: rand() > 0.05 },
    ];
    if (roll > 0.04) docs.push({ workerId: w!.id, type: "medical", expiryDate: baseExpiry(60), verified: true });
    await db.orm.insert(workerDocuments).values(docs);
  }

  console.log(`Seeded ${count} fictional workers and 3 sites`);
  await seedMasters(db, today);
  await db.sql.end();
}

// ---------------------------------------------------------------------------------------------
// Document masters (PRD 4.19, A26). Its own random sequence, so the workers above stay the same,
// and idempotent, so it can run on an existing database (`bun src/db/seed.ts --masters-only`).
// ---------------------------------------------------------------------------------------------

let state2 = 4_192_026;
const rand2 = () => {
  state2 = (state2 * 1_103_515_245 + 12_345) % 2_147_483_648;
  return state2 / 2_147_483_648;
};
const int2 = (min: number, max: number) => min + Math.floor(rand2() * (max - min + 1));

const OWN_PLACEHOLDER = "Own company (record the legal name)";
/** Days from today to each company document's expiry: a mix of valid, due and one expired. */
const COMPANY_PAPERS: Record<OrganisationDocumentType, number> = {
  commercial_registration: 210,
  chamber_certificate: 40,
  tax_card: 300,
  vat_certificate: 520,
  activity_licence: -5,
  tenancy_agreement: 130,
  municipality_licence: 75,
  labour_authorisation: 260,
};
const SUBCONTRACTORS = [
  { legalName: "Batinah Workforce Supply LLC", cr: "2000101", crExpiry: 180 },
  { legalName: "Dhofar Labour Contracting LLC", cr: "2000102", crExpiry: 25 },
];
const CLIENTS = [
  { legalName: "Gulf Build LLC", cr: "3000201", crExpiry: 400 },
  { legalName: "Al Noor Contracting", cr: "3000202", crExpiry: 12 },
  { legalName: "Batinah Steel", cr: "3000203", crExpiry: null }, // CR not recorded yet: shows as missing
];

async function seedMasters(db: Database, today: CalendarDate) {
  const sql = db.sql;
  const by = "seed";
  const paper = async (owner: { sponsorId?: string; clientId?: string }, type: OrganisationDocumentType, number: string, days: number) => {
    const [exists] = owner.sponsorId
      ? await sql`select 1 from organisation_documents where sponsor_id = ${owner.sponsorId} and type = ${type}`
      : await sql`select 1 from organisation_documents where client_id = ${owner.clientId!} and type = ${type}`;
    if (exists) return;
    await sql`insert into organisation_documents (id, sponsor_id, client_id, type, number, issue_date, expiry_date, verified, verified_by, verified_at, created_by)
      values (${Bun.randomUUIDv7()}, ${owner.sponsorId ?? null}, ${owner.clientId ?? null}, ${type}, ${number},
              ${addDays(today, days - 365)}, ${addDays(today, days)}, true, ${by}, now(), ${by})`;
  };

  // The company itself (In House masters 1-8).
  let [own] = await sql<{ id: string; legal_name: string }[]>`select id, legal_name from sponsors where kind = 'own' and entity_id = 'OM-01'`;
  if (!own) {
    [own] = await sql<{ id: string; legal_name: string }[]>`insert into sponsors (id, kind, legal_name, created_by, updated_by)
      values (${Bun.randomUUIDv7()}, 'own', ${OWN_PLACEHOLDER}, ${by}, ${by}) returning id, legal_name`;
  }
  if (own!.legal_name === OWN_PLACEHOLDER) {
    await sql`update sponsors set legal_name = 'Demo Manpower Services LLC', cr_number = '1000001', mol_establishment_no = 'EST-1000001', updated_by = ${by} where id = ${own!.id}`;
  }
  for (const type of ORGANISATION_DOCUMENT_TYPES) {
    await paper({ sponsorId: own!.id }, type, `${type.slice(0, 3).toUpperCase()}-${int2(100000, 999999)}`, COMPANY_PAPERS[type]);
  }

  // Sub-contractors (Purchase master 13) and clients (Sales master 18).
  const subIds: string[] = [];
  for (const s of SUBCONTRACTORS) {
    let [row] = await sql<{ id: string }[]>`select id from sponsors where lower(cr_number) = ${s.cr}`;
    if (!row) {
      [row] = await sql<{ id: string }[]>`insert into sponsors (id, kind, legal_name, cr_number, mol_establishment_no, created_by, updated_by)
        values (${Bun.randomUUIDv7()}, 'external', ${s.legalName}, ${s.cr}, ${`EST-${s.cr}`}, ${by}, ${by}) returning id`;
    }
    subIds.push(row!.id);
    await paper({ sponsorId: row!.id }, "commercial_registration", s.cr, s.crExpiry);
  }
  for (const c of CLIENTS) {
    let [row] = await sql<{ id: string }[]>`select id from clients where lower(cr_number) = ${c.cr}`;
    if (!row) {
      [row] = await sql<{ id: string }[]>`insert into clients (id, legal_name, cr_number, vat_number, created_by, updated_by)
        values (${Bun.randomUUIDv7()}, ${c.legalName}, ${c.cr}, ${`OM11${c.cr}`}, ${by}, ${by}) returning id`;
    }
    if (c.crExpiry !== null) await paper({ clientId: row!.id }, "commercial_registration", c.cr, c.crExpiry);
  }

  // Every worker has an engagement (PRD 4.18): the company's own from the day they joined.
  await sql`insert into worker_sponsorships (id, entity_id, worker_id, sponsor_id, engagement, valid_from, created_by)
    select gen_random_uuid(), w.entity_id, w.id, ${own!.id}, 'own', coalesce(w.joined_on, w.created_at::date), ${by}
    from workers w where w.entity_id = 'OM-01' and not exists (select 1 from worker_sponsorships s where s.worker_id = w.id)`;

  // A few indirect employees: every sixteenth active worker is supplied by a sub-contractor from today,
  // under a Ministry authorisation verified by someone other than its recorder.
  const [count] = await sql<{ n: number }[]>`select count(*)::int as n from worker_sponsorships where engagement <> 'own'`;
  if (count!.n === 0) {
    const candidates = await sql<{ id: string; sid: string }[]>`
      select w.id, s.id as sid from workers w
      join worker_sponsorships s on s.worker_id = w.id and s.valid_to is null and s.engagement = 'own' and s.valid_from < ${today}
      where w.status in ('available','deployed','on_leave') order by w.code`;
    const chosen = candidates.filter((_, i) => i % 16 === 0);
    for (const [i, c] of chosen.entries()) {
      await sql.begin(async (tx) => {
        await tx`update worker_sponsorships set valid_to = ${addDays(today, -1)} where id = ${c.sid}`;
        await tx`insert into worker_sponsorships (id, worker_id, sponsor_id, engagement, authorisation_ref, authorisation_verified_by, authorisation_verified_at, valid_from, created_by)
          values (${Bun.randomUUIDv7()}, ${c.id}, ${subIds[i % subIds.length]!}, 'supplied', ${`MOL-AUTH-${int2(10000, 99999)}`}, 'seed.hr.lead', now(), ${today}, ${by})`;
      });
    }
  }

  // Oman ID cards and medical insurance for every worker who lacks them (A28; about 3% are left without
  // insurance so the masters show what "missing" looks like), and Sohar gate passes for about a quarter.
  const lacking = (type: string) =>
    sql<{ id: string; code: string }[]>`select w.id, w.code from workers w where not exists (select 1 from worker_documents d where d.worker_id = w.id and d.type = ${type}) order by w.code`;
  type Doc = { worker_id: string; type: string; number: string; expiry_date: string; verified: boolean };
  const docs: Doc[] = [];
  for (const w of await lacking("civil_id")) {
    docs.push({ worker_id: w.id, type: "civil_id", number: `1${int2(1000000, 9999999)}`, expiry_date: addDays(today, int2(-10, 730)), verified: true });
  }
  for (const w of await lacking("medical_insurance")) {
    if (Number(w.code.slice(2)) % 33 === 0) continue; // the same workers every run, so a rerun adds nothing
    docs.push({ worker_id: w.id, type: "medical_insurance", number: `MI-${int2(100000, 999999)}`, expiry_date: addDays(today, int2(-30, 330)), verified: rand2() > 0.05 });
  }
  const [anyPass] = await sql`select 1 from worker_documents where type = 'sohar_gate_pass' limit 1`;
  if (!anyPass) {
    for (const w of await lacking("sohar_gate_pass")) {
      if (rand2() > 0.25) continue;
      docs.push({ worker_id: w.id, type: "sohar_gate_pass", number: `SGP-${int2(10000, 99999)}`, expiry_date: addDays(today, int2(-15, 300)), verified: true });
    }
  }
  for (let i = 0; i < docs.length; i += 500) {
    const batch = docs.slice(i, i + 500).map((d) => ({ id: crypto.randomUUID(), ...d, verified_by: d.verified ? by : null, verified_at: d.verified ? new Date().toISOString() : null }));
    await sql`insert into worker_documents ${sql(batch, "id", "worker_id", "type", "number", "expiry_date", "verified", "verified_by", "verified_at")}`;
  }
  await sql`update sites set required_documents = array['sohar_gate_pass'] where code = 'SOH-PORT' and required_documents = '{}'`;

  console.log(`Masters: company papers, ${SUBCONTRACTORS.length} sub-contractors, ${CLIENTS.length} clients, ${docs.length} worker documents`);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
