import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { isLinkedInProfileUrl, type PageCandidate } from "./parser";
import "./popup.css";

const apiBase = "http://localhost:4000";
const savedCompanyKey = "recruiter-reachout-current-company";

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

function Popup() {
  const [rows, setRows] = useState<CandidateRow[]>([]);
  const [company, setCompany] = useState("");
  const [pageMode, setPageMode] = useState<PageMode>("other");
  const [preview, setPreview] = useState<PageCandidate | undefined>();
  const [knownEmail, setKnownEmail] = useState<string | undefined>();
  const [loadingPreview, setLoadingPreview] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Checking the current page…");

  useEffect(() => {
    setCompany(localStorage.getItem(savedCompanyKey) ?? "");
    void inspectActiveTab();
  }, []);

  function updateCompany(value: string) {
    setCompany(value);
    localStorage.setItem(savedCompanyKey, value);
  }

  async function collectFromTab(tabId: number): Promise<CollectResponse> {
    try {
      return (await chrome.tabs.sendMessage(tabId, { type: "COLLECT_RECRUITERS" })) as CollectResponse;
    } catch {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["assets/content.js"],
      });
      return (await chrome.tabs.sendMessage(tabId, { type: "COLLECT_RECRUITERS" })) as CollectResponse;
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
        setStatus("Open a LinkedIn profile or search results page.");
        return;
      }

      if (isLinkedInProfileUrl(tab.url)) {
        setPageMode("profile");
        setStatus("Reading this LinkedIn profile…");
        try {
          const response = await collectFromTab(tab.id);
          const person = response.candidates[0];
          setPreview(person);
          const suggested = response.companySuggestion?.trim() || person?.company?.trim();
          const savedCompany = (localStorage.getItem(savedCompanyKey) ?? "").trim();
          if (suggested) {
            updateCompany(suggested);
          } else if (savedCompany) {
            updateCompany(savedCompany);
          }
          if (person) {
            const checks = await lookupKnown([person], suggested || savedCompany || undefined);
            const hit = checks[0];
            if (hit?.knownEmail) {
              setKnownEmail(hit.knownEmail);
              if (hit.company && !suggested) {
                updateCompany(hit.company);
              }
              setStatus(`Known contact: ${person.fullName} · ${hit.knownEmail}`);
            } else {
              setStatus(
                suggested
                  ? `Ready to add ${person.fullName} at ${suggested}.`
                  : `Ready to add ${person.fullName}. Confirm the company below.`,
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

      if (/linkedin\.com|google\.|bing\./i.test(tab.url)) {
        setPageMode("search");
        setStatus("Open a LinkedIn search results page, then save visible profiles.");
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
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        setStatus("No active tab found.");
        return;
      }
      const response = await collectFromTab(tab.id);
      const captureCompany = company.trim() || response.companySuggestion?.trim() || response.candidates[0]?.company?.trim();
      if (!captureCompany) {
        setStatus(
          pageMode === "profile"
            ? "Enter the company name before adding this person."
            : "Enter the company name before saving visible profiles.",
        );
        return;
      }
      if (!company.trim()) {
        updateCompany(captureCompany);
      }
      if (response.candidates.length === 0) {
        setRows([]);
        setStatus(
          pageMode === "profile"
            ? "Couldn't read this LinkedIn profile."
            : "No visible LinkedIn profile results found on this page.",
        );
        return;
      }
      const candidates = response.candidates.map((candidate) => ({
        ...candidate,
        company: candidate.company || captureCompany,
      }));
      setPreview(candidates[0]);
      setRows(candidates.map((candidate) => ({ candidate, status: "new" })));
      const saved = await fetch(`${apiBase}/api/candidates/bulk`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ candidates, company: captureCompany }),
      });
      if (!saved.ok) {
        const error = (await saved.json()) as { error?: string };
        setRows(candidates.map((candidate) => ({ candidate, status: "error", message: error.error ?? "Failed to save." })));
        throw new Error(error.error ?? "Failed to save.");
      }
      const payload = (await saved.json()) as {
        results: Array<{
          key: string;
          status: "saved_now" | "skipped_duplicate" | "previously_contacted" | "known_email";
          knownEmail?: string;
        }>;
      };
      const statusByKey = new Map(payload.results.map((result) => [result.key, result]));
      setRows(
        candidates.map((candidate) => {
          const result = statusByKey.get(candidateKey(candidate));
          return {
            candidate,
            status: result?.status ?? "already_active",
            knownEmail: result?.knownEmail,
          };
        }),
      );
      const savedNow = payload.results.filter((result) => result.status === "saved_now").length;
      const skipped = payload.results.filter((result) => result.status === "skipped_duplicate").length;
      const previous = payload.results.filter((result) => result.status === "previously_contacted").length;
      const known = payload.results.filter((result) => result.status === "known_email").length;
      if (pageMode === "profile") {
        const person = candidates[0];
        const result = payload.results[0];
        if (result?.knownEmail) {
          setKnownEmail(result.knownEmail);
        }
        if (result?.status === "saved_now") {
          setStatus(`Added ${person?.fullName} at ${captureCompany}.`);
        } else if (result?.status === "known_email") {
          setStatus(`${person?.fullName} already in directory · ${result.knownEmail}`);
        } else if (result?.status === "skipped_duplicate") {
          setStatus(`${person?.fullName} is already in your active batch.`);
        } else if (result?.status === "previously_contacted") {
          setStatus(`${person?.fullName} was contacted before — marked in the list.`);
        } else {
          setStatus(`Finished for ${person?.fullName}.`);
        }
      } else {
        setStatus(
          `Saved ${savedNow} new, ${known} known email(s), skipped ${skipped} active, ${previous} previous contact(s) for ${captureCompany}.`,
        );
      }
    } finally {
      setBusy(false);
    }
  }

  async function clearCurrentList() {
    const toRemove = rows.map((row) => row.candidate);
    setBusy(true);
    try {
      let archivedCount = 0;
      if (toRemove.length > 0) {
        const response = await fetch(`${apiBase}/api/candidates/active/remove-matching`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ candidates: toRemove }),
        });
        if (!response.ok) {
          const error = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(error.error ?? "Failed to clear dashboard candidates.");
        }
        const payload = (await response.json()) as { archived?: unknown[] };
        archivedCount = payload.archived?.length ?? 0;
      }
      setRows([]);
      setStatus(
        archivedCount > 0
          ? `Cleared the list and removed ${archivedCount} from the dashboard.`
          : "Cleared the list. No matching active dashboard candidates were found.",
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to clear the list.");
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
          <p className="eyebrow">Recruiter Reachout</p>
          <h1>{pageMode === "profile" ? "Add this recruiter" : "Capture recruiters"}</h1>
        </div>
        <span className={`mode-chip ${pageMode}`}>
          {pageMode === "profile" ? "Profile" : pageMode === "search" ? "Search" : "Page"}
        </span>
      </header>

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
        {pageMode === "profile" ? "Company (auto-filled when possible)" : "Current company"}
        <input
          value={company}
          onChange={(event) => updateCompany(event.target.value)}
          placeholder={pageMode === "profile" ? "e.g. Google" : "Company name for this batch"}
        />
      </label>

      <div className="action-row">
        <button
          className="primary"
          disabled={busy || loadingPreview}
          onClick={() => void saveProfiles().catch((error: Error) => setStatus(error.message))}
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
        <button className="secondary" disabled={busy || rows.length === 0} onClick={() => void clearCurrentList()}>
          Clear list + dashboard
        </button>
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
  return normalizeLinkedInUrl(candidate.linkedinUrl) || candidate.fullName.trim().toLowerCase();
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
