/**
 * `_links` and `agent` descriptor builders for API responses.
 * Shapes mirror upstream server/proof-sdk-routes.ts so the public agent
 * contract survives the fork unchanged (hard-fork ADR).
 */

const AGENT_DOCS_PATH = '/agent-docs';

export function buildProofSdkLinks(
  slug: string,
  opts: { includeMutationRoutes?: boolean; includeBridgeRoutes?: boolean } = {},
): Record<string, unknown> {
  const links: Record<string, unknown> = {
    create: { method: 'POST', href: '/documents' },
    state: `/documents/${slug}/state`,
    presence: { method: 'POST', href: `/documents/${slug}/presence` },
    events: `/documents/${slug}/events/pending?after=0`,
    docs: AGENT_DOCS_PATH,
  };
  if (opts.includeMutationRoutes) {
    links.ops = { method: 'POST', href: `/documents/${slug}/ops` };
    links.edit = { method: 'POST', href: `/documents/${slug}/edit` };
    links.title = { method: 'PUT', href: `/documents/${slug}/title` };
  }
  if (opts.includeBridgeRoutes) {
    links.bridge = {
      state: `/documents/${slug}/bridge/state`,
      marks: `/documents/${slug}/bridge/marks`,
      comment: { method: 'POST', href: `/documents/${slug}/bridge/comments` },
      suggestion: {
        method: 'POST',
        href: `/documents/${slug}/bridge/suggestions`,
      },
      rewrite: { method: 'POST', href: `/documents/${slug}/bridge/rewrite` },
      presence: { method: 'POST', href: `/documents/${slug}/bridge/presence` },
    };
  }
  return links;
}

export function buildProofSdkAgentDescriptor(slug: string): Record<string, unknown> {
  return {
    what: 'Proof SDK collaborative document',
    docs: AGENT_DOCS_PATH,
    createApi: '/documents',
    stateApi: `/documents/${slug}/state`,
    presenceApi: `/documents/${slug}/presence`,
    eventsApi: `/documents/${slug}/events/pending`,
    opsApi: `/documents/${slug}/ops`,
    editApi: `/documents/${slug}/edit`,
    titleApi: `/documents/${slug}/title`,
    bridgeApi: {
      state: `/documents/${slug}/bridge/state`,
      marks: `/documents/${slug}/bridge/marks`,
      comments: `/documents/${slug}/bridge/comments`,
      suggestions: `/documents/${slug}/bridge/suggestions`,
      rewrite: `/documents/${slug}/bridge/rewrite`,
      presence: `/documents/${slug}/bridge/presence`,
      events: `/documents/${slug}/events/pending`,
      ack: `/documents/${slug}/events/ack`,
    },
  };
}
