/**
 * @file src/api/client.ts
 * @description Centralized HTTP client for all Opes API requests.
 *
 * ================================================================
 * WHY A CENTRALIZED API CLIENT?
 * ================================================================
 *
 * Without this file, every component that needs data would have to:
 *   1. Manually write fetch() with the correct headers
 *   2. Manually add the Authorization: Bearer <token> header
 *   3. Manually handle non-OK responses
 *   4. Manually parse the JSON response
 *
 * That's 4 things to get right in every component. One mistake
 * (e.g., forgetting the Authorization header) and the request fails silently.
 *
 * This centralized client handles all of that automatically. Components just call:
 *   const data = await apiRequest<InventoryResponse>('/inventory');
 *
 * ================================================================
 * JWT STORAGE: localStorage vs httpOnly Cookies
 * ================================================================
 *
 * We store the JWT in localStorage for simplicity in Phase 1.
 *
 * SECURITY TRADE-OFF:
 *   localStorage is accessible to JavaScript running on the page.
 *   If an attacker injects malicious JavaScript (XSS attack), they could
 *   steal the token from localStorage. This is the main drawback.
 *
 * ALTERNATIVE (more secure): Store the JWT in an httpOnly cookie.
 *   - httpOnly cookies are NOT accessible to JavaScript — XSS cannot steal them.
 *   - The browser sends them automatically with every request.
 *   - Drawback: requires CSRF protection (e.g., SameSite=Strict cookie attribute).
 *
 * For a game in Phase 1, localStorage is an acceptable trade-off.
 * The primary defense against XSS is a strict Content-Security-Policy header
 * (set by helmet in the backend) and careful handling of user-generated content.
 * Migrate to httpOnly cookies as the security requirements grow.
 */

/** Base path for all API requests. Vite proxies this to http://localhost:3001 in dev. */
const API_BASE_URL = '/api/v1';

/** localStorage key for the JWT. Namespaced to avoid conflicts with other apps. */
const TOKEN_KEY = 'opes_auth_token';

/** localStorage key for the cached user object (id + username). */
const USER_KEY = 'opes_auth_user';

// ================================================================
// TOKEN MANAGEMENT
// ================================================================

/** Retrieves the stored JWT from localStorage, or null if not present. */
export const getToken = (): string | null =>
  localStorage.getItem(TOKEN_KEY);

/** Persists the JWT to localStorage after a successful login/register. */
export const setToken = (token: string): void =>
  localStorage.setItem(TOKEN_KEY, token);

/** Removes the JWT from localStorage on logout or when the token becomes invalid. */
export const removeToken = (): void =>
  localStorage.removeItem(TOKEN_KEY);

// ================================================================
// USER CACHE MANAGEMENT
// ================================================================

/**
 * Shape of the user object stored in localStorage.
 * Matches what the server returns in the login/register responses.
 */
export interface StoredUser {
  id:       string;
  username: string;
}

/** Retrieves the cached user object, or null if not present or corrupted. */
export const getStoredUser = (): StoredUser | null => {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredUser;
  } catch {
    // If the stored JSON is corrupted, clear it and return null.
    localStorage.removeItem(USER_KEY);
    return null;
  }
};

/** Persists the user object to localStorage alongside the token. */
export const setStoredUser = (user: StoredUser): void =>
  localStorage.setItem(USER_KEY, JSON.stringify(user));

/** Removes the user object from localStorage on logout. */
export const removeStoredUser = (): void =>
  localStorage.removeItem(USER_KEY);

// ================================================================
// TOKEN EXPIRY CHECK (Client-side)
// ================================================================

/**
 * Checks whether a JWT has expired by decoding its payload client-side.
 *
 * HOW JWT DECODING WORKS:
 * A JWT has three parts: header.payload.signature
 * The payload is base64url-encoded JSON. We can decode it without the secret
 * key — we're just reading the data, not verifying the signature.
 * The 'exp' claim is a Unix timestamp (seconds since 1970-01-01).
 *
 * WHY CHECK EXPIRY CLIENT-SIDE?
 * The server will reject expired tokens with a 401 error. But checking
 * client-side lets us immediately show the login screen on app load
 * without making a wasted network request that we know will fail.
 *
 * IMPORTANT: Client-side expiry check is a UX optimization, NOT a security
 * measure. Security is enforced server-side by jwt.verify() in authMiddleware.
 *
 * @param token - A JWT string.
 * @returns true if the token is expired or cannot be parsed, false if still valid.
 */
export const isTokenExpired = (token: string): boolean => {
  try {
    // Split the JWT into its 3 parts and decode the middle part (payload).
    const payloadBase64 = token.split('.')[1];
    if (!payloadBase64) return true;

    // atob() decodes base64. We then parse the JSON string.
    const payload = JSON.parse(atob(payloadBase64)) as { exp?: number };

    if (typeof payload.exp !== 'number') return true;

    // payload.exp is in seconds; Date.now() is in milliseconds.
    return Date.now() >= payload.exp * 1000;
  } catch {
    // If anything goes wrong parsing, treat the token as expired/invalid.
    return true;
  }
};

// ================================================================
// API REQUEST FUNCTION
// ================================================================

/**
 * Makes an authenticated HTTP request to the Opes API.
 *
 * Features:
 *   - Automatically prepends API_BASE_URL to the endpoint path.
 *   - Automatically sets Content-Type: application/json.
 *   - Automatically adds Authorization: Bearer <token> if a token is stored.
 *   - Throws a descriptive Error if the response is not OK (non-2xx status).
 *   - Returns the parsed JSON response body cast to type T.
 *
 * The generic type parameter <T> lets callers specify the expected response shape:
 *   const data = await apiRequest<{ inventory: InventoryRow[] }>('/inventory');
 *   data.inventory; // TypeScript knows this is InventoryRow[]
 *
 * @param endpoint - The API path (e.g., '/inventory', '/auth/login'). Must start with '/'.
 * @param options  - Standard RequestInit options (method, body, etc.). Headers are merged.
 * @returns A Promise resolving to the parsed JSON response body as type T.
 * @throws An Error with the server's error message if the response is not OK.
 */
export const apiRequest = async <T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> => {
  const token = getToken();

  // Build headers: start with Content-Type, merge any caller-provided headers,
  // then conditionally add the Authorization header if a token is available.
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> ?? {}),
  };

  if (token) {
    // The "Bearer" scheme is defined in RFC 6750.
    // The server's authMiddleware expects exactly this format.
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    // Try to parse the error body as JSON (our API always returns { error: string }).
    // If parsing fails (e.g., a proxy returned an HTML error page), fall back to
    // a generic message that includes the HTTP status code for debugging.
    const errorBody = await response
      .json()
      .catch(() => ({ error: `HTTP ${response.status}: ${response.statusText}` }));

    throw new Error(
      (errorBody as { error?: string }).error ??
      `Unexpected error (HTTP ${response.status})`
    );
  }

  return response.json() as Promise<T>;
};
