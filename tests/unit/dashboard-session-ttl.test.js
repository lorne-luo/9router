import { describe, it, expect, vi } from "vitest";
import { decodeJwt } from "jose";

process.env.JWT_SECRET = "test-secret-dashboard-session-ttl";

vi.mock("@/lib/localDb", () => ({ getSettings: vi.fn() }));

const { createDashboardAuthToken, setDashboardAuthCookie, verifyDashboardAuthToken } =
  await import("../../src/lib/auth/dashboardSession.js");

const ONE_WEEK_SEC = 7 * 24 * 60 * 60;

describe("dashboard session TTL", () => {
  it("issues a JWT that expires one week after issue", async () => {
    const token = await createDashboardAuthToken();
    const { iat, exp } = decodeJwt(token);
    expect(exp - iat).toBe(ONE_WEEK_SEC);
    expect(await verifyDashboardAuthToken(token)).toBe(true);
  });

  it("sets the auth cookie maxAge to one week", async () => {
    const cookieStore = { set: vi.fn() };
    await setDashboardAuthCookie(cookieStore, null);
    expect(cookieStore.set).toHaveBeenCalledWith(
      "auth_token",
      expect.any(String),
      expect.objectContaining({ maxAge: ONE_WEEK_SEC, httpOnly: true }),
    );
  });

  it("rejects a token once the week has passed", async () => {
    const token = await createDashboardAuthToken();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + (ONE_WEEK_SEC + 60) * 1000);
      expect(await verifyDashboardAuthToken(token)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
