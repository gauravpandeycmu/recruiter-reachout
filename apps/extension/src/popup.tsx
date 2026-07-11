import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { normalizeWhitespace } from "@recruiter/shared";
import { isLinkedInProfileUrl, type PageCandidate } from "./parser";
import "./popup.css";

const apiBase = "http://localhost:4000";
const savedCompanyKey = "recruiter-reachout-current-company";
const dashboardChannel = "recruiter-reachout-saved";
const extensionVersion = "0.1.3";

type PageMode = "profile" | "search" | "other";
type CandidateResultStatus =
  | "new"
  | "already_active"
  | "previously_contacted"
  | "saved_now"
  | "skipped_duplicate"
  | "known_email"
  | "error";

interface CandidateRow {
  candidate: PageCandidate;
  status: CandidateResultStatus;
  message?: string;
  knownEmail?: string;
}

interface CollectResponse {
  candidates: PageCandidate[];
  companySuggestion?: string;
  error?: string;
}

interface CheckResult {
  key: string;
  status: CandidateResultStatus;
  knownEmail?: string;
  knownEmails?: string[];
  company?: string;
}

interface CollectOptions {
  /** Scroll search results to lazy-load avatars — only needed when saving, not when opening the popup. */
  prepareLazyLoad?: boolean;
}

function Popup() {
  const [rows, setRows] = useState<CandidateRow[]>([]);
  const [company, setCompany] = useState("");
  const [pageMode, setPageMode] = useState<PageMode>("other");
  const [preview, setPreview] = useState<PageCandidate | undefined>();
  const [knownEmail, setKnownEmail] = useState<string | undefined>();
  const [loadingPreview, setLoadingPreview] = useState(true);
  const [busy, setBusy] = useState(false);
  const [apiOnline, setApiOnline] = useState<boolean | undefined>(undefined);
  const [status, setStatus] = useState("Checking the current page…");
  const [sourceTabId, setSourceTabId] = useState<number | undefined>();
  const [sourceTabUrl, setSourceTabUrl] = useState<string | undefined>();

  useEffect(() => {
    setCompany(localStorage.getItem(savedCompanyKey) ?? "");
    void Promise.all([inspectActiveTab(), pingApi()]).then(([, online]) => {
      if (!online) {
        setStatus((prev) =>
          prev.startsWith("Dashboard API")
            ? prev
            : `${prev} Dashboard API is offline — run npm run dev and keep the API on :4000.`,
        );
      }
    });
  }, []);

  function updateCompany(value: string) {
    setCompany(value);
    localStorage.setItem(savedCompanyKey, value);
  }

  /** Only auto-fill company when the user has not typed one — never overwrite manual input. */
  function applyCompanySuggestion(suggested: string | undefined) {
    const saved = (localStorage.getItem(savedCompanyKey) ?? "").trim();
    if (saved) {
      setCompany(saved);
      return saved;
    }
    const next = suggested?.trim();
    if (next) {
      updateCompany(next);
      return next;
    }
    return "";
  }

  async function pingApi(): Promise<boolean> {
    try {
      const response = await fetch(`${apiBase}/health`, { signal: AbortSignal.timeout(2500) });
      const online = response.ok;
      setApiOnline(online);
      return online;
    } catch {
      setApiOnline(false);
      return false;
    }
  }

  async function collectFromTab(tabId: number, options: CollectOptions = {}): Promise<CollectResponse> {
    const message = {
      type: "COLLECT_RECRUITERS",
      prepareLazyLoad: options.prepareLazyLoad ?? false,
    };
    try {
      return (await chrome.tabs.sendMessage(tabId, message)) as CollectResponse;
    } catch {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["assets/content.js"],
      });
      return (await chrome.tabs.sendMessage(tabId, message)) as CollectResponse;
    }
  }

  async function lookupKnown(candidates: PageCandidate[], companyHint?: string): Promise<CheckResult[]> {
    try {
      const response = await fetch(`${apiBase}/api/candidates/check`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ candidates, company: companyHint }),
      });
      if (!response.ok) {
        return [];
      }
      const payload = (await response.json()) as { results: CheckResult[] };
      return payload.results ?? [];
    } catch {
      return [];
    }
  }

  async function inspectActiveTab() {
    setLoadingPreview(true);
    setKnownEmail(undefined);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !tab.url) {
        setPageMode("other");
        setSourceTabId(undefined);
        setSourceTabUrl(undefined);
        setStatus("Open a LinkedIn profile or search results page.");
        return;
      }
      setSourceTabId(tab.id);
      setSourceTabUrl(tab.url);

      if (isLinkedInProfileUrl(tab.url)) {
        setPageMode("profile");
        setStatus("Reading this LinkedIn profile…");
        try {
          const response = await collectFromTab(tab.id, { prepareLazyLoad: false });
          const person = response.candidates[0];
          setPreview(person);
          const activeCompany = applyCompanySuggestion(response.companySuggestion?.trim() || person?.company?.trim());
          if (person) {
            const checks = await lookupKnown([person], activeCompany || undefined);
            const hit = checks[0];
            if (hit?.knownEmail) {
              setKnownEmail(hit.knownEmail);
              setStatus(`Known contact: ${person.fullName} · ${hit.knownEmail}`);
            } else {
              setStatus(
                activeCompany
                  ? `Ready to add ${person.fullName} at ${activeCompany}.`
                  : `Ready to add ${person.fullName}. Enter the company below.`,
              );
            }
          } else {
            setStatus(
              response.error
                ? `Profile read failed: ${response.error}`
                : "Couldn't read this profile. Refresh the LinkedIn page and try again.",
            );
          }
        } catch {
          setStatus("Couldn't reach this page. Refresh LinkedIn, then reopen the extension.");
        }
        return;
      }

      if (/linkedin\.com\/search\/results\/people/i.test(tab.url)) {
        setPageMode("search");
        const saved = (localStorage.getItem(savedCompanyKey) ?? "").trim();
        setStatus(
          saved
            ? `Ready to save visible profiles for ${saved}.`
            : "Enter the company name, then save visible profiles.",
        );
        return;
      }

      if (/linkedin\.com|google\.|bing\./i.test(tab.url)) {
        setPageMode("search");
        setStatus("Open a LinkedIn people search results page, then save visible profiles.");
        return;
      }

      setPageMode("other");
      setStatus("Open a LinkedIn profile or people search, then use this extension.");
    } finally {
      setLoadingPreview(false);
    }
  }

  async function saveProfiles() {
    setBusy(true);
    setRows([]);
    try {
      const online = apiOnline ?? (await pingApi());
      if (!online) {
        throw new Error("Dashboard API is offline. Run npm run dev (API on http://localhost:4000) and try again.");
      }

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const linkedInTabId = sourceTabId ?? tab?.id;
      if (!linkedInTabId) {
        setStatus("No LinkedIn tab found — reopen the extension from LinkedIn.");
        return;
      }
      const linkedInUrl = sourceTabUrl ?? tab?.url;
      const response = await collectFromTab(linkedInTabId, { prepareLazyLoad: pageMode === "search" });
      const manualCompany = company.trim();
      let collected = response.candidates;
      if (collected.length === 0 && pageMode === "profile" && preview?.fullName) {
        collected = [
          {
            ...preview,
            linkedinUrl: preview.linkedinUrl || linkedInUrl?.split("?")[0],
          },
        ];
      }
      const captureCompany =
        manualCompany ||
        response.companySuggestion?.trim() ||
        collected[0]?.company?.trim() ||
        preview?.company?.trim() ||
        "General";
      if (!manualCompany && captureCompany !== "General") {
        updateCompany(captureCompany);
      }
      if (collected.length === 0) {
        setStatus(
          pageMode === "profile"
            ? response.error
              ? `Profile read failed: ${response.error}`
              : "Couldn't read this LinkedIn profile — refresh the page, wait for it to load, then try again."
            : "No visible LinkedIn profile results found on this page.",
        );
        return;
      }
      const candidates = collected.map((candidate) => ({
        ...candidate,
        company: manualCompany || captureCompany,
        linkedinUrl: candidate.linkedinUrl || linkedInUrl?.split("?")[0],
      }));
      setPreview(candidates[0]);
      setStatus(pageMode === "search" ? "Saving profiles to dashboard…" : "Adding to dashboard…");

      const saved = await fetch(`${apiBase}/api/candidates/bulk`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ candidates, company: captureCompany }),
      });
      if (!saved.ok) {
        const error = (await saved.json().catch(() => ({}))) as { error?: string };
        const message = error.error ?? `Failed to save (HTTP ${saved.status}).`;
        setRows(candidates.map((candidate) => ({ candidate, status: "error", message })));
        throw new Error(message);
      }
      const payload = (await saved.json()) as {
        results: Array<{
          key: string;
          status: CandidateResultStatus;
          knownEmail?: string;
          error?: string;
        }>;
        activeCount?: number;
      };
      const statusByKey = new Map(payload.results.map((result) => [result.key, result]));
      const nextRows = candidates.map((candidate, index) => {
        const result = payload.results[index] ?? statusByKey.get(candidateKey(candidate));
        if (!result) {
          return {
            candidate,
            status: "error" as const,
            message: "No save result from dashboard.",
          };
        }
        if (result.status === "error") {
          return {
            candidate,
            status: "error" as const,
            message: result.error ?? "Failed to save.",
          };
        }
        return {
          candidate,
          status: result.status,
          knownEmail: result.knownEmail,
        };
      });
      setRows(nextRows);
      const savedNow = nextRows.filter((row) => row.status === "saved_now").length;
      const skipped = nextRows.filter((row) => row.status === "skipped_duplicate").length;
      const previous = nextRows.filter((row) => row.status === "previously_contacted").length;
      const known = nextRows.filter((row) => row.status === "known_email").length;
      const errors = nextRows.filter((row) => row.status === "error").length;
      let activeCount = payload.activeCount;
      if (activeCount == null) {
        try {
          const state = (await fetch(`${apiBase}/api/state`).then((r) => r.json())) as {
            candidates?: unknown[];
          };
          activeCount = state.candidates?.length ?? 0;
        } catch {
          activeCount = undefined;
        }
      }
      const countNote =
        activeCount != null ? ` Dashboard has ${activeCount} active recipient(s).` : "";
      const addedCount = savedNow + previous + known;
      if (pageMode === "profile") {
        const person = candidates[0];
        const result = nextRows[0];
        if (result?.knownEmail) {
          setKnownEmail(result.knownEmail);
        }
        if (result?.status === "saved_now") {
          setStatus(`Added ${person?.fullName} at ${captureCompany}.${countNote}`);
        } else if (result?.status === "known_email") {
          setStatus(`${person?.fullName} reactivated on dashboard · ${result.knownEmail}${countNote}`);
        } else if (result?.status === "skipped_duplicate") {
          setStatus(`${person?.fullName} is already on the dashboard.${countNote}`);
        } else if (result?.status === "previously_contacted") {
          setStatus(`${person?.fullName} was contacted before — reactivated on the dashboard.${countNote}`);
        } else if (result?.status === "error") {
          setStatus(result.message ?? `Could not save ${person?.fullName}.`);
        } else {
          setStatus(`Finished for ${person?.fullName}.${countNote}`);
        }
      } else {
        setStatus(
          errors > 0
            ? `Saved ${savedNow} new, ${known} known, ${skipped} already active, ${previous} previous, ${errors} failed for ${captureCompany}.${countNote}`
            : `Saved ${savedNow} new, ${known} known, ${skipped} already active, ${previous} previous for ${captureCompany}.${countNote}`,
        );
      }
      if (errors > 0) {
        setStatus((prev) => `${prev} Fix errors above, then try again.`);
        return;
      }
      if (addedCount === 0 && skipped === 0) {
        setStatus(`Nothing was saved — no profiles were read from this page.${countNote}`);
        return;
      }
      if (activeCount === 0) {
        setStatus(
          `Save finished but the dashboard still shows 0 active recipients. Run npm run dev, click Refresh on the dashboard, then try again.${countNote}`,
        );
        notifyDashboard();
        return;
      }
      notifyDashboard();
      void openDashboardTab();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to save profiles.");
    } finally {
      setBusy(false);
    }
  }

  function clearPopupList() {
    setRows([]);
    setStatus("Cleared the popup list. Dashboard recipients are unchanged.");
  }

  async function removeSavedFromDashboard() {
    const toRemove = rows.map((row) => row.candidate);
    if (toRemove.length === 0) {
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`${apiBase}/api/candidates/active/remove-matching`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ candidates: toRemove }),
      });
      if (!response.ok) {
        const error = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(error.error ?? "Failed to remove from dashboard.");
      }
      const payload = (await response.json()) as { archived?: unknown[] };
      const archivedCount = payload.archived?.length ?? 0;
      setRows([]);
      setStatus(
        archivedCount > 0
          ? `Removed ${archivedCount} matching recipient(s) from the dashboard.`
          : "No matching active dashboard recipients were found.",
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to remove from dashboard.");
    } finally {
      setBusy(false);
    }
  }

  const primaryLabel =
    pageMode === "profile" ? (busy ? "Adding…" : "Add this person") : busy ? "Saving…" : "Save all visible";

  return (
    <main className={pageMode === "profile" ? "mode-profile" : undefined}>
      <header className="popup-header">
        <div>
          <p className="eyebrow">Recruiter Reachout · v{extensionVersion}</p>
          <h1>{pageMode === "profile" ? "Add this recruiter" : "Capture recruiters"}</h1>
        </div>
        <span className={`mode-chip ${pageMode}`}>
          {pageMode === "profile" ? "Profile" : pageMode === "search" ? "Search" : "Page"}
        </span>
      </header>

      {apiOnline === false && (
        <p className="warning">Dashboard API offline — start the app with npm run dev (port 4000).</p>
      )}

      <p className="status">{status}</p>

      {pageMode === "profile" && (
        <section className="profile-card">
          {loadingPreview && <p className="hint">Loading profile…</p>}
          {!loadingPreview && preview && (
            <div className="profile-preview">
              {preview.profilePhotoUrl ? <img className="avatar large" src={preview.profilePhotoUrl} alt="" /> : <div className="avatar large placeholder" />}
              <div>
                <strong>{preview.fullName}</strong>
                {preview.title && <small>{preview.title}</small>}
                {(preview.company || company) && <small className="company-line">{preview.company || company}</small>}
                {preview.location && <small>{preview.location}</small>}
                {knownEmail && <small className="known-email">Known email · {knownEmail}</small>}
              </div>
            </div>
          )}
          {!loadingPreview && !preview && <p className="hint">No profile details yet — try refreshing LinkedIn.</p>}
        </section>
      )}

      <label>
        {pageMode === "profile" ? "Company" : "Current company"}
        <input
          value={company}
          onChange={(event) => updateCompany(event.target.value)}
          placeholder={pageMode === "profile" ? "e.g. Google" : "Company name for this batch"}
        />
      </label>

      <div className="action-row">
        <button
          className="primary"
          disabled={busy || (pageMode === "profile" && loadingPreview)}
          onClick={() => void saveProfiles()}
        >
          {primaryLabel}
        </button>
        <a className="dashboard-link" href="http://localhost:3000" target="_blank" rel="noreferrer">
          Open dashboard
        </a>
      </div>

      {rows.length > 0 && (
        <div className="list">
          {rows.map((row) => {
            const key = candidateKey(row.candidate);
            return (
              <div className="candidate" key={key}>
                <span>
                  <strong>{row.candidate.fullName}</strong>
                  {row.candidate.profilePhotoUrl && <img className="avatar" src={row.candidate.profilePhotoUrl} alt="" />}
                  <small>{row.candidate.title ?? row.candidate.linkedinUrl}</small>
                  {row.candidate.company && <small>{row.candidate.company}</small>}
                  {row.knownEmail && <small className="known-email">{row.knownEmail}</small>}
                  {row.candidate.location && <small>{row.candidate.location}</small>}
                </span>
                <strong className={`badge ${row.status}`}>{formatStatus(row.status)}</strong>
                {row.message && <small>{row.message}</small>}
              </div>
            );
          })}
        </div>
      )}

      {rows.length > 0 && (
        <div className="list-actions">
          <button className="secondary" disabled={busy} onClick={clearPopupList}>
            Clear popup list
          </button>
          <button className="secondary subtle-danger" disabled={busy} onClick={() => void removeSavedFromDashboard()}>
            Remove from dashboard
          </button>
        </div>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Popup />
  </React.StrictMode>,
);

function candidateKey(candidate: PageCandidate): string {
  return normalizeLinkedInUrl(candidate.linkedinUrl) || normalizeWhitespace(candidate.fullName).toLowerCase();
}

function notifyDashboard(): void {
  try {
    const channel = new BroadcastChannel(dashboardChannel);
    channel.postMessage({ type: "refresh", at: Date.now() });
    channel.close();
  } catch {
    // Dashboard may not be open yet.
  }
}

async function openDashboardTab(): Promise<void> {
  const url = `http://localhost:3000/?saved=${Date.now()}#send`;
  try {
    await chrome.tabs.create({ url, active: true });
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

function normalizeLinkedInUrl(url: string | undefined): string {
  if (!url) {
    return "";
  }
  try {
    const parsed = new URL(url);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return url.split("?")[0]?.replace(/\/$/, "").toLowerCase() ?? "";
  }
}

function formatStatus(status: CandidateResultStatus): string {
  switch (status) {
    case "already_active":
    case "skipped_duplicate":
      return "Already active";
    case "previously_contacted":
      return "Previously contacted";
    case "known_email":
      return "Known email";
    case "saved_now":
      return "Saved now";
    case "error":
      return "Error";
    case "new":
      return "New";
  }
}
