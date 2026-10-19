import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import es from "../../../messages/es.json";
import { OnboardingForm } from "./onboarding-form";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));
const clientApi = vi.fn();
vi.mock("@/lib/client-api", () => ({
  clientApi: (...args: unknown[]) => clientApi(...args) as Promise<unknown>,
  ClientApiError: class ClientApiError extends Error {},
}));

const initial = {
  timezone: "Europe/Madrid",
  workStart: "09:00",
  workEnd: "18:00",
  workDays: [1, 2, 3, 4, 5],
  contingencyPct: 20,
};

function setup() {
  return render(
    <NextIntlClientProvider locale="es" messages={es}>
      <OnboardingForm initial={initial} />
    </NextIntlClientProvider>,
  );
}

describe("OnboardingForm (F-01)", () => {
  it("submits the preferences with completeOnboarding and navigates to Hoy", async () => {
    clientApi.mockResolvedValue({});
    setup();
    const range = document.querySelector('input[name="contingencyPct"]');
    if (!range) throw new Error("range input missing");
    fireEvent.change(range, { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: es.onboarding.submit }));
    await waitFor(() => {
      expect(clientApi).toHaveBeenCalledTimes(1);
    });
    const [path, init] = clientApi.mock.calls[0] as [
      string,
      { method: string; json: Record<string, unknown> },
    ];
    expect(path).toBe("/v1/preferences");
    expect(init.method).toBe("PUT");
    expect(init.json).toMatchObject({
      timezone: "Europe/Madrid",
      workStart: "09:00",
      workEnd: "18:00",
      workDays: [1, 2, 3, 4, 5],
      contingencyPct: 30,
      completeOnboarding: true,
    });
    await waitFor(() => {
      expect(push).toHaveBeenCalledWith("/hoy");
    });
  });

  it("validates that the start time is before the end time and that one day is selected", async () => {
    clientApi.mockClear();
    setup();
    const end = document.querySelector('input[name="workEnd"]');
    if (!end) throw new Error("workEnd input missing");
    fireEvent.change(end, { target: { value: "08:00" } });
    for (const d of [1, 2, 3, 4, 5])
      fireEvent.click(
        screen.getByRole("button", { name: es.onboarding.dayNames[String(d) as "1"], pressed: true }),
      );
    fireEvent.click(screen.getByRole("button", { name: es.onboarding.submit }));
    await waitFor(() => {
      expect(screen.getAllByRole("alert").map((a) => a.textContent)).toEqual(
        expect.arrayContaining([es.onboarding.errors.order, es.onboarding.errors.days]),
      );
    });
    expect(clientApi).not.toHaveBeenCalled();
  });
});
