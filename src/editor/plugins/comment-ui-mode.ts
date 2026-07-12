export type CommentUiMode = 'legacy' | 'v2' | 'auto';

export const COMMENT_UI_MODE_QUERY_KEY = 'commentUi';
export const COMMENT_UI_MODE_STORAGE_KEY = 'proofeditor.commentUi';
export const COMMENT_UI_MODE_WIDTH_FALLBACK_PX = 900;

type ProofConfigWindow = Window & {
  __PROOF_CONFIG__?: {
    commentUiDefaultMode?: string;
  };
};

function normalizeCommentUiMode(value: string | null | undefined): CommentUiMode | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'legacy' || normalized === 'v2' || normalized === 'auto') return normalized;
  return null;
}

function getQueryMode(): CommentUiMode | null {
  if (typeof window === 'undefined') return null;
  try {
    const params = new URLSearchParams(window.location.search);
    return normalizeCommentUiMode(params.get(COMMENT_UI_MODE_QUERY_KEY));
  } catch {
    return null;
  }
}

function getStorageMode(): CommentUiMode | null {
  if (typeof window === 'undefined') return null;
  try {
    return normalizeCommentUiMode(window.localStorage.getItem(COMMENT_UI_MODE_STORAGE_KEY));
  } catch {
    return null;
  }
}

function getRuntimeDefaultMode(): CommentUiMode | null {
  if (typeof window === 'undefined') return null;
  return normalizeCommentUiMode((window as ProofConfigWindow).__PROOF_CONFIG__?.commentUiDefaultMode);
}

export function getCommentUiMode(): CommentUiMode {
  return getQueryMode() ?? getStorageMode() ?? getRuntimeDefaultMode() ?? 'auto';
}

export function shouldUseCommentUiV2(): boolean {
  const mode = getCommentUiMode();
  if (mode === 'legacy') return false;
  if (mode === 'v2') return true;
  if (typeof window === 'undefined') return false;

  const coarsePointer = typeof window.matchMedia === 'function'
    ? window.matchMedia('(pointer: coarse)').matches
    : false;
  if (coarsePointer) return true;
  return window.innerWidth <= COMMENT_UI_MODE_WIDTH_FALLBACK_PX;
}
