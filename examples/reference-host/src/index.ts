// reference-host — a bare Interchange host (`createApp` from the published
// `@intx/hub-api`) with @corbits/mailbox mounted the way the package's own
// README Quickstart documents it: `installMailbox`, taking the host's own
// dependencies as parameters instead of closing over them inline.
//
// The host is the real thing: hub routes, the hub request logger and the hub
// session middleware are all live, and the mailbox principal is resolved out of
// the hub's own request context (`c.var.user`) rather than out of a local
// variable. That is the point of this example — it proves the frozen
// `mount<Name>(app, opts)` seam composes with an Interchange app, not just with
// a bare Hono instance.
//
// `test/acceptance.test.ts` drives this host through the end-to-end acceptance
// scenarios against a real Postgres.
import { Hono } from "hono";
import type { Context } from "hono";
import { createApp, type AppEnv } from "@intx/hub-api";
import { createDB } from "@intx/db";
import {
  createSidecarCredentialResolver,
  createSidecarRouter,
  createEventCollectorRegistry,
  type SessionService,
} from "@intx/hub-sessions";
import {
  runMailboxMigrations,
  mountMailbox,
  createInMemoryMailboxEventBus,
  createMailboxDb,
  type MailboxDb,
  type MailboxEventBus,
  type MountMailboxOpts,
} from "@corbits/mailbox";

export const DATABASE_URL =
  process.env.MAILBOX_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5433/mailbox_core";

export type Session = { tenantId: string; principalId: string } | null;

const EPOCH = new Date(0);

// `@intx/db` takes discrete connection fields rather than a URL.
function toDbConfig(raw: string) {
  const url = new URL(raw);
  return {
    host: url.hostname,
    port: Number(url.port === "" ? "5432" : url.port),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ""),
  };
}

/**
 * `installMailbox`, in the exact shape the README Quickstart documents it:
 * the host's own `databaseUrl`, `resolvePrincipal`, `senderAddressFor` and
 * `deliver` arrive as typed parameters, `mountMailbox` goes on a sub-app the
 * host routes under `/api`, and the mailbox's own db/bus handles come back
 * out for the host (and this example's tests) to drive directly.
 */
function installMailbox(
  app: Hono<AppEnv>,
  opts: {
    databaseUrl: string;
    resolvePrincipal: MountMailboxOpts["resolvePrincipal"];
    senderAddressFor: MountMailboxOpts["senderAddressFor"];
    deliver: MountMailboxOpts["deliver"];
  },
): { db: MailboxDb; bus: MailboxEventBus } {
  const { db } = createMailboxDb(opts.databaseUrl);
  // In-process fan-out for this single host process.
  const bus = createInMemoryMailboxEventBus();

  const api = new Hono<AppEnv>();
  mountMailbox(api, {
    db,
    bus,
    resolvePrincipal: opts.resolvePrincipal,
    senderAddressFor: opts.senderAddressFor,
    deliver: opts.deliver,
  });
  // The convention: mounted @corbits/* modules serve under `/api`, matching
  // Interchange's own `app.route("/api/me", …)` / `app.route("/api/tenants", …)`.
  // The core registers its routes root-relative (`/me/inbox*`), so the host
  // nests them in a sub-app and routes that sub-app at `/api`. No `/v1`
  // segment and no vendor prefix — the served paths are `/api/me/inbox*`.
  app.route("/api", api);

  return { db, bus };
}

export type ReferenceHost = {
  db: MailboxDb;
  /**
   * The very bus the mount is wired to. Exposed so the acceptance suite can
   * drive the SSE leg through a real write rather than a hand-rolled publish
   * into a bus the host is not actually using.
   */
  bus: MailboxEventBus;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  /** Who is signed in to the hub for subsequent requests; null = signed out. */
  setSession: (session: Session) => void;
  /**
   * Every message the mailbox's `deliver` mount dep was handed, in order.
   * This reference host owns no real transport, so `deliver` just records
   * here — the acceptance suite asserts against it instead of a network call.
   */
  deliveries: { raw: Uint8Array; from: string; to: string[]; messageId: string }[];
};

export async function createReferenceHost(): Promise<ReferenceHost> {
  // The hub's own control-plane handle (tenant/principal/sidecar tables).
  // The mailbox gets its own connection via `installMailbox` below, exactly
  // as a real host's `installMailbox(app, { databaseUrl, … })` call does.
  const hub = createDB(toDbConfig(DATABASE_URL));

  let session: Session = { tenantId: "acme", principalId: "user-1" };

  const getSession = async () => {
    if (session === null) return null;
    const id = `${session.tenantId}:${session.principalId}`;
    return {
      user: {
        id,
        createdAt: EPOCH,
        updatedAt: EPOCH,
        email: `${session.principalId}@${session.tenantId}.example`,
        emailVerified: true,
        name: session.principalId,
      },
      session: {
        id: `session-${id}`,
        createdAt: EPOCH,
        updatedAt: EPOCH,
        userId: id,
        expiresAt: new Date(Date.now() + 3_600_000),
        token: `token-${id}`,
      },
    };
  };

  // A bare Interchange host: a real sidecar router (built the published way,
  // off `createSidecarCredentialResolver`) and a real event-collector
  // registry. The host runs no agent sessions, so its SessionService refuses
  // every launch verb rather than pretending to serve it, and it opts out of
  // the asset/git surface by passing null for both.
  const refuse = (verb: string) => (): never => {
    throw new Error(`reference-host runs no agent sessions: ${verb}`);
  };
  const sidecarCredentials = createSidecarCredentialResolver({ db: hub.db });
  const sidecarRouter = createSidecarRouter({
    authenticateSidecar: async ({ token }) => sidecarCredentials.resolve(token),
    validateSidecarIdentity: sidecarCredentials.isCurrent,
  });
  const sessionService: SessionService = {
    stageWorkflowStep: refuse("stageWorkflowStep"),
    endSession: refuse("endSession"),
  };

  const app = createApp({
    getSession,
    authHandler: () => new Response("", { status: 404 }),
    db: hub.db,
    sidecarRouter,
    sessionService,
    eventCollectors: createEventCollectorRegistry({ db: hub.db }),
    assetService: null,
    repoStore: null,
    maxTarballBytes: 10_000_000,
  });

  // The hub authenticates a *user*; the mailbox is keyed by (tenant,
  // principal). This host encodes one as the other, so mapping between them is
  // a string split — a real host would look the principal up in its own
  // directory. Note it reads the hub request context, not the local `session`
  // variable: if the hub did not authenticate the request, the mailbox sees no
  // principal.
  const resolvePrincipal = (ctx: unknown): Session => {
    const user = (ctx as Context<AppEnv>).get("user");
    if (!user) return null;
    const [tenantId, principalId] = user.id.split(":");
    return tenantId && principalId ? { tenantId, principalId } : null;
  };

  const deliveries: ReferenceHost["deliveries"] = [];
  const { db, bus } = installMailbox(app, {
    databaseUrl: DATABASE_URL,
    resolvePrincipal,
    // Matches `getSession`'s own `email` derivation above: this host encodes
    // the mailbox address as `<principalId>@<tenantId>.example` throughout.
    senderAddressFor: ({ tenantId, principalId }) =>
      `${principalId}@${tenantId}.example`,
    // No real transport here — see `ReferenceHost.deliveries`.
    deliver: (message) => {
      deliveries.push(message);
    },
  });

  // Boot order a real host follows: the control plane (here the hub's own
  // tables) must exist before the mailbox migrations can FK to it. Resetting
  // state for re-runnable scenarios is the TEST harness's job, not the host's
  // — see `test/acceptance.test.ts`.
  await runMailboxMigrations(db);

  return {
    db,
    bus,
    request: async (path, init) => app.request(path, init),
    setSession: (next) => {
      session = next;
    },
    deliveries,
  };
}
