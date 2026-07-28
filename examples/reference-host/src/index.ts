// reference-host — a bare Interchange host (`createApp` from the published
// `@intx/hub-api`) with @corbits/mailbox mounted on it.
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
  createEventCollectorRegistry,
  createSidecarRouter,
  type SessionService,
  type SidecarAuthenticator,
} from "@intx/hub-sessions";
import {
  runMailboxMigrations,
  mountMailbox,
  createInMemoryMailboxEventBus,
  type MailboxDb,
  type MailboxEventBus,
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
};

export async function createReferenceHost(): Promise<ReferenceHost> {
  // One pool. The mailbox mounts on the handle the host already has from
  // `createDB` — the seam takes any drizzle postgres-js instance, so there is
  // no second connection to the same database.
  const hub = createDB(toDbConfig(DATABASE_URL));
  const db: MailboxDb = hub.db;
  // Boot order a real host follows: the control plane (here the hub's own
  // tables) must exist before the mailbox migrations can FK to it. Resetting
  // state for re-runnable scenarios is the TEST harness's job, not the host's
  // — see `test/acceptance.test.ts`.
  await runMailboxMigrations(db);

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

  // A bare Interchange host: real sidecar router, real event-collector
  // registry. The host runs no agent sessions, so its SessionService refuses
  // every launch verb rather than pretending to serve it, and it opts out of
  // the asset/git surface by passing null for both.
  const authenticateSidecar: SidecarAuthenticator = async ({ sidecarId }) => ({
    kind: "sidecar",
    sidecarId,
  });
  const refuse = (verb: string) => (): never => {
    throw new Error(`reference-host runs no agent sessions: ${verb}`);
  };
  const sessionService: SessionService = {
    stageWorkflowStep: refuse("stageWorkflowStep"),
    deployInstanceAtHead: refuse("deployInstanceAtHead"),
    deploySingleStepAtHead: refuse("deploySingleStepAtHead"),
    deployWorkflowDefinition: refuse("deployWorkflowDefinition"),
    sendUserMessage: refuse("sendUserMessage"),
    endSession: refuse("endSession"),
  };

  const app = createApp({
    getSession,
    authHandler: () => new Response("", { status: 404 }),
    db: hub.db,
    sidecarRouter: createSidecarRouter({ authenticateSidecar }),
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

  const bus = createInMemoryMailboxEventBus();
  // The convention: mounted @corbits/* modules serve under `/api`, matching
  // Interchange's own `app.route("/api/me", …)` / `app.route("/api/tenants", …)`.
  // The core registers its routes root-relative (`/me/inbox*`), so the host
  // nests them in a sub-app and routes that sub-app at `/api`. No `/v1`
  // segment and no vendor prefix — the served paths are `/api/me/inbox*`.
  const api = new Hono<AppEnv>();
  // The triage vocabulary is the HOST's, not the package's: the core ships the
  // ranking mechanism and generates its OpenAPI enums from whatever this host
  // declares here. A different product would list different words.
  mountMailbox(api, {
    db,
    bus,
    resolvePrincipal,
    vocabulary: {
      priorities: ["urgent", "high", "normal", "low"],
      statuses: ["needs-action", "done"],
    },
  });
  app.route("/api", api);

  return {
    db,
    bus,
    request: async (path, init) => app.request(path, init),
    setSession: (next) => {
      session = next;
    },
  };
}
