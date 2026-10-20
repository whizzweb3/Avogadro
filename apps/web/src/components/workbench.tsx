"use client";

import { useCallback, useEffect, useState } from "react";
import { CHAIN_ID, type CampaignStatus } from "@avogadro/shared";

type Section = "Overview" | "Contracts" | "Campaigns" | "Invariants" | "Artifacts";
type ContractSummary = { id: string; address: string; chainId: number; importStatus?: string; verified?: boolean; provenanceUrl?: string | null; name?: string };
type Campaign = { id: string; status: CampaignStatus | "completed" | "infrastructure_blocked"; fixtureId: string; outcome?: string | null; failureKind?: string | null; failureCode?: string | null; seed?: string; runs?: number; depth?: number; timeoutSeconds?: number; selectedInvariants?: string[]; executionDigest?: string; sourceDigest?: string; result?: Record<string, unknown> | null; attempts?: Array<{ attemptNumber: number; status: string; result?: Record<string, unknown> | null }>; createdAt?: string; cancelRequestedAt?: string | null; replayOf?: string | null };

declare global {
  interface Window { ethereum?: { request(args: { method: string; params?: unknown[] }): Promise<unknown> } }
}

const sections: Section[] = ["Overview", "Contracts", "Campaigns", "Invariants", "Artifacts"];
const api = "/api";

function useResource<T>(path: string, enabled = true) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    if (!enabled) { setData(null); setLoading(false); setError(null); return; }
    setLoading(true); setError(null);
    try {
      const response = await fetch(`${api}${path}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`Request failed (${response.status})`);
      setData(await response.json() as T);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not reach the API.");
    } finally { setLoading(false); }
  }, [enabled, path]);
  useEffect(() => { void reload(); }, [reload]);
  return { data, loading, error, reload };
}

function StatusDot({ status }: { status: string }) {
  const positive = status === "ok" || status === "running" || status === "passed";
  return <span className={`status-dot ${positive ? "is-live" : ""}`} aria-hidden="true" />;
}

export default function Workbench() {
  const [section, setSection] = useState<Section>("Overview");
  const [address, setAddress] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authUnavailable, setAuthUnavailable] = useState(false);
  const [campaignNotice, setCampaignNotice] = useState<string | null>(null);
  const [selectedCampaign, setSelectedCampaign] = useState<Campaign | null>(null);
  const [campaignBusy, setCampaignBusy] = useState(false);
  const [fixtureId, setFixtureId] = useState("vault-accounting-v1");
  const [seed, setSeed] = useState("");
  const [runs, setRuns] = useState(256);
  const [depth, setDepth] = useState(32);
  const [timeoutSeconds, setTimeoutSeconds] = useState(90);
  const { data: health, loading: healthLoading, error: healthError, reload: reloadHealth } = useResource<{ status: string; service: string }>("/health");
  const { data: contractData, loading: contractsLoading, error: contractsError, reload: reloadContracts } = useResource<{ contracts?: ContractSummary[] } | ContractSummary[]>("/v1/contracts", authenticated);
  const { data: campaignData, loading: campaignsLoading, error: campaignsError, reload: reloadCampaigns } = useResource<{ campaigns?: Campaign[] } | Campaign[]>("/v1/campaigns", authenticated);
  const contracts = Array.isArray(contractData) ? contractData : contractData?.contracts ?? [];
  const campaigns = Array.isArray(campaignData) ? campaignData : campaignData?.campaigns ?? [];

  useEffect(() => {
    let active = true;
    fetch(`${api}/v1/auth/session`, { cache: "no-store" }).then(async (response) => {
      if (!active) return;
      if (response.ok) {
        await response.json();
        setAuthenticated(true);
      } else setAuthenticated(false);
    }).catch(() => { if (active) setAuthenticated(false); }).finally(() => { if (active) setAuthLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!authenticated || !campaigns.some((campaign) => ["queued", "running"].includes(campaign.status))) return;
    const timer = window.setInterval(() => { void reloadCampaigns(); }, 4000);
    return () => window.clearInterval(timer);
  }, [authenticated, campaigns, reloadCampaigns]);

  useEffect(() => {
    if (!authenticated || !selectedCampaign || !["queued", "running"].includes(selectedCampaign.status)) return;
    const campaignId = selectedCampaign.id;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`${api}/v1/campaigns/${campaignId}`, { cache: "no-store" });
        if (response.ok) {
          const latest = await response.json() as Campaign;
          setSelectedCampaign((current) => current?.id === campaignId ? latest : current);
        }
      } catch { /* The list poll and its retry controls remain available if detail polling is interrupted. */ }
    }, 4000);
    return () => window.clearInterval(timer);
  }, [authenticated, selectedCampaign?.id, selectedCampaign?.status]);

  async function connectWallet() {
    setNotice(null); setAuthUnavailable(false);
    try {
      if (!window.ethereum) throw new Error("No compatible wallet provider was detected in this browser.");
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" }) as string[];
      const wallet = accounts?.[0];
      if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) throw new Error("The wallet did not return a valid account.");
      const chain = await window.ethereum.request({ method: "eth_chainId" }) as string;
      if (Number.parseInt(chain, 16) !== CHAIN_ID) throw new Error(`Switch the wallet to chain ${CHAIN_ID} before signing in.`);
      const nonceResponse = await fetch(`${api}/v1/auth/nonce`, { cache: "no-store" });
      const nonceBody = await nonceResponse.json().catch(() => ({}));
      if (!nonceResponse.ok) {
        if (nonceResponse.status === 503) setAuthUnavailable(true);
        throw new Error(nonceBody?.error?.message ?? `SIWE nonce request failed (${nonceResponse.status})`);
      }
      const { nonce, domain, uri, chainId } = nonceBody as { nonce: string; domain: string; uri: string; chainId: number };
      const message = `${domain} wants you to sign in with your Ethereum account:\n${wallet}\n\nSign in to AVOGADRO.\n\nURI: ${uri}\nVersion: 1\nChain ID: ${chainId}\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;
      const signature = await window.ethereum.request({ method: "personal_sign", params: [message, wallet] }) as string;
      const verifyResponse = await fetch(`${api}/v1/auth/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message, signature }) });
      const verifyBody = await verifyResponse.json().catch(() => ({}));
      if (!verifyResponse.ok) throw new Error(verifyBody?.error?.message ?? `SIWE verification failed (${verifyResponse.status})`);
      setAuthenticated(true); setWalletAddress(wallet); setNotice("Wallet session established.");
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : "Wallet sign-in failed."); }
  }

  async function logout() {
    try {
      const csrf = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("avogadro_csrf="))?.slice("avogadro_csrf=".length);
      const response = await fetch(`${api}/v1/auth/logout`, { method: "POST", headers: csrf ? { "x-csrf-token": decodeURIComponent(csrf) } : {} });
      if (!response.ok) throw new Error(`Sign-out failed (${response.status})`);
      setAuthenticated(false); setWalletAddress(null); setSelectedCampaign(null);
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : "Sign-out failed."); }
  }

  function generateSeed() {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    setSeed(`0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`);
  }

  function csrfHeaders(): Record<string, string> {
    const value = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("avogadro_csrf="))?.slice("avogadro_csrf=".length);
    return value ? { "x-csrf-token": decodeURIComponent(value) } : {};
  }

  async function createCampaign(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setCampaignNotice(null); setCampaignBusy(true);
    const invariant = fixtureId === "vault-accounting-v1" ? "invariant_accountingMatchesSuccessfulActions" : "invariant_replayValueRemainsZero";
    try {
      const response = await fetch(`${api}/v1/campaigns`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID(), ...csrfHeaders() }, body: JSON.stringify({ fixtureId, invariants: [invariant], seed, runs, depth, timeoutSeconds }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error?.message ?? `Campaign creation failed (${response.status})`);
      setCampaignNotice(`Campaign ${body.id} accepted with status ${body.status}.`); await reloadCampaigns(); setSection("Campaigns");
    } catch (cause) { setCampaignNotice(cause instanceof Error ? cause.message : "Campaign creation failed."); }
    finally { setCampaignBusy(false); }
  }

  async function campaignAction(campaign: Campaign, action: "cancel" | "replay") {
    setCampaignNotice(null); setCampaignBusy(true);
    try {
      const response = await fetch(`${api}/v1/campaigns/${campaign.id}/${action}`, { method: "POST", headers: csrfHeaders() });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error?.message ?? `${action} failed (${response.status})`);
      setCampaignNotice(action === "cancel" ? `Cancellation requested for ${campaign.id}.` : `Replay ${body.id} accepted with status ${body.status}.`);
      await reloadCampaigns();
      if (action === "replay" && body.id) void openCampaign(body.id);
    } catch (cause) { setCampaignNotice(cause instanceof Error ? cause.message : `${action} failed.`); }
    finally { setCampaignBusy(false); }
  }

  async function openCampaign(id: string) {
    try {
      const response = await fetch(`${api}/v1/campaigns/${id}`, { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error?.message ?? `Campaign detail failed (${response.status})`);
      setSelectedCampaign(body as Campaign);
    } catch (cause) { setCampaignNotice(cause instanceof Error ? cause.message : "Campaign detail unavailable."); }
  }

  async function importContract(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setNotice(null);
    try {
      const response = await fetch(`${api}/v1/contracts`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID(), ...csrfHeaders() }, body: JSON.stringify({ chainId: CHAIN_ID, address }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error?.message ?? `Import failed (${response.status})`);
      setNotice("Import request received. Verification status will appear when the API confirms it."); setAddress(""); await reloadContracts();
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : "Import failed."); }
  }

  const contractCount = contracts.length;
  const activeCount = campaigns.filter((campaign) => campaign.status === "queued" || campaign.status === "running").length;

  return <main className="shell">
    <aside className="sidebar">
      <a className="wordmark" href="#overview" onClick={(event) => { event.preventDefault(); setSection("Overview"); }} aria-label="AVOGADRO home"><span className="mark">A</span><span>AVOGADRO<small>SECURITY LAB</small></span></a>
      <div className="side-label">WORKSPACE</div>
      <nav aria-label="Main navigation" className="nav-list">
        {sections.map((item, index) => <button key={item} onClick={() => setSection(item)} className={`nav-item ${section === item ? "selected" : ""}`} aria-current={section === item ? "page" : undefined}><span className="nav-icon">{["◫", "⌘", "◷", "◇", "↗"][index]}</span>{item}{item === "Campaigns" && activeCount > 0 && <span className="nav-count">{activeCount}</span>}</button>)}
      </nav>
      <div className="sidebar-bottom"><div className="network-card"><span className="network-orb offline-orb" /><div><b>Robinhood Chain</b><small>CONFIGURED · {CHAIN_ID}</small></div><span className="verified-mark" aria-label="Configured chain">◌</span></div><div className="profile"><div className="avatar">{walletAddress?.slice(2, 3).toUpperCase() ?? "L"}</div><div><b>{authenticated && walletAddress ? `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}` : authenticated ? "SIWE session" : "Local workspace"}</b><small>{authLoading ? "Checking session" : authenticated ? "SIWE session active" : "Not signed in"}</small></div>{authenticated ? <button className="text-button" onClick={() => void logout()}>Sign out</button> : <button className="text-button" onClick={() => void connectWallet()} disabled={authLoading}>Sign in</button>}</div></div>
    </aside>
    <section className="main-area">
      <header className="topbar"><div className="breadcrumb"><span>Workspace</span><i>/</i><b>{section}</b></div><div className="top-actions"><div className={`api-indicator ${healthError ? "offline" : ""}`}><StatusDot status={health?.status ?? "offline"} />{healthLoading ? "Checking API" : healthError ? "API unavailable" : "API connected"}</div><button className="icon-button" onClick={() => { void reloadHealth(); if (authenticated) { void reloadContracts(); void reloadCampaigns(); } }} aria-label="Refresh data">↻</button>{authenticated ? <button className="user-chip" aria-label="Signed in wallet" title={walletAddress ?? "Signed in"}>{walletAddress?.slice(2, 3).toUpperCase() ?? "W"}</button> : <button className="sign-in-button" onClick={() => void connectWallet()} disabled={authLoading}>Connect wallet</button>}</div></header>
      <div className="content">
        {!authLoading && !authenticated && <div className="auth-banner"><span className="state-icon">⌑</span><div><b>Sign in to access your workspace</b><small>Contract records and campaigns are private to your SIWE session. Sign-in requires an injected wallet on chain {CHAIN_ID}.</small>{authUnavailable && <small className="error-copy">SIWE is not configured on the API.</small>}</div><button className="primary-button" onClick={() => void connectWallet()}>Sign in with wallet ↗</button></div>}
        {section === "Overview" && <>
          <div className="eyebrow"><span className="eyebrow-line" />SECURITY WORKSPACE <span className="eyebrow-dot">·</span> CHAIN {CHAIN_ID}</div>
          <div className="hero-row"><div><h1>Contract security,<br /><em>without guesswork.</em></h1><p className="lede">Run reproducible invariant campaigns against trusted repository fixtures in a local test EVM. Every result stays traceable to its source, snapshot, and seed.</p></div><div className="hero-side"><div className="snapshot-icon">⌁</div><p>MAINNET TARGET<br /><b>RPC not configured</b></p></div></div>
          <div className="metrics"><Metric label="IMPORTED CONTRACTS" value={contractsLoading ? "—" : String(contractCount).padStart(2, "0")} detail={contractsLoading ? "Loading records" : contractsError ? "Data unavailable" : "Imported records · verification per contract"} icon="⌘" /><Metric label="ACTIVE CAMPAIGNS" value={campaignsLoading ? "—" : String(activeCount).padStart(2, "0")} detail={campaignsLoading ? "Loading records" : campaignsError ? "Data unavailable" : "API lifecycle status"} icon="◷" /><Metric label="CHAIN CONFIGURATION" value={String(CHAIN_ID)} detail="Robinhood Chain · RPC not configured" icon="◈" /><Metric label="EXECUTION" value="FIXTURES" detail="Local Foundry test EVM · imported sources disabled" icon="▣" /></div>
          <div className="section-heading"><div><div className="eyebrow">YOUR LAB</div><h2>Start with a contract</h2></div><span className="muted">Contract verification required before testing</span></div>
          <div className="work-grid">
            <div className="panel import-panel"><div className="panel-head"><div><span className="step">01</span><h3>Import a contract</h3></div><span className="subtle-tag">EXPLORER PROVENANCE</span></div><p className="panel-copy">Enter a Robinhood Chain address. The API records explorer verification metadata and on-chain runtime bytecode. It does not independently recompile and prove source equivalence in this phase.</p><form onSubmit={importContract}><label htmlFor="contract-address">CONTRACT ADDRESS</label><div className="input-row"><input id="contract-address" value={address} onChange={(event) => setAddress(event.target.value)} placeholder="0x…" pattern="0x[a-fA-F0-9]{40}" title="Enter a 20-byte EVM address" required /><button className="primary-button" type="submit" disabled={contractsLoading || !authenticated}>Check availability <span>↗</span></button></div></form>{!authenticated && <div className="fixture-note">Sign in with SIWE before importing a contract.</div>}{notice && <div className="notice" role="status">{notice}</div>}<div className="secure-note"><span>◈</span> Read-only provider requests. No wallet transaction signing.</div></div>
            <div className="panel readiness"><div className="panel-head"><div><span className="step">02</span><h3>Configure a fixture run</h3></div><span className="subtle-tag">TRUSTED SOURCE</span></div><p className="panel-copy">Run only repository-owned Foundry fixtures. Imported contract sources and mainnet fork execution are not enabled.</p><CampaignComposer fixtureId={fixtureId} setFixtureId={setFixtureId} seed={seed} setSeed={setSeed} generateSeed={generateSeed} runs={runs} setRuns={setRuns} depth={depth} setDepth={setDepth} timeoutSeconds={timeoutSeconds} setTimeoutSeconds={setTimeoutSeconds} busy={campaignBusy} authenticated={authenticated} notice={campaignNotice} onSubmit={createCampaign} /></div>
          </div>
          <div className="lower-grid"><div className="panel records-panel"><div className="section-heading compact"><div><div className="eyebrow">RECENT CONTRACTS</div><h2>Contract workspace</h2></div><button className="text-button" onClick={() => setSection("Contracts")}>View all <span>↗</span></button></div><RecordsState loading={contractsLoading} error={contractsError} empty={contractCount === 0} label="No contracts imported" description="Imported contracts and their provider verification status appear here." retry={reloadContracts} /><div className="record-list">{contracts.slice(0, 3).map((contract) => <div className="record-row" key={contract.id}><span className="record-token">{(contract.name ?? "C").slice(0, 1)}</span><span className="record-name"><b>{contract.name ?? "Unnamed contract"}</b><small>{contract.address}</small></span><span className="verified-label">{contract.verified ? "verified" : contract.importStatus ?? "unknown"}</span></div>)}</div></div>
            <div className="panel campaigns-panel"><div className="section-heading compact"><div><div className="eyebrow">CAMPAIGN ACTIVITY</div><h2>Recent runs</h2></div><button className="text-button" onClick={() => setSection("Campaigns")}>All campaigns <span>↗</span></button></div><RecordsState loading={campaignsLoading} error={campaignsError} empty={campaigns.length === 0} label="No campaigns yet" description="Campaigns appear here after a trusted fixture run is queued." retry={reloadCampaigns} /><div className="record-list">{campaigns.slice(0, 3).map((campaign) => <div className="record-row" key={campaign.id}><span className="run-token"><StatusDot status={campaign.status} /></span><span className="record-name"><b>{campaign.fixtureId}</b><small>{campaign.id}</small></span><button className="text-button" onClick={() => { setSection("Campaigns"); void openCampaign(campaign.id); }}>Inspect</button><span className="verified-label">{campaign.status}</span></div>)}</div></div></div>
          <footer><span>AVOGADRO <i>·</i> REPRODUCIBLE BY DESIGN</span><span>GENERATED TRANSACTIONS NEVER REACH MAINNET</span></footer>
        </>}
        {section !== "Overview" && <WorkspaceSection section={section} contracts={contracts} campaigns={campaigns} loading={section === "Contracts" ? contractsLoading : section === "Campaigns" ? campaignsLoading : false} error={section === "Contracts" ? contractsError : section === "Campaigns" ? campaignsError : null} retry={section === "Contracts" ? reloadContracts : reloadCampaigns} fixtureId={fixtureId} setFixtureId={setFixtureId} seed={seed} setSeed={setSeed} generateSeed={generateSeed} runs={runs} setRuns={setRuns} depth={depth} setDepth={setDepth} timeoutSeconds={timeoutSeconds} setTimeoutSeconds={setTimeoutSeconds} busy={campaignBusy} authenticated={authenticated} campaignNotice={campaignNotice} onCreate={createCampaign} selectedCampaign={selectedCampaign} onOpenCampaign={openCampaign} onCampaignAction={campaignAction} onCloseCampaign={() => setSelectedCampaign(null)} />}
      </div>
    </section>
  </main>;
}

function Metric({ label, value, detail, icon }: { label: string; value: string; detail: string; icon: string }) {
  return <div className="metric"><div className="metric-top"><span>{label}</span><i>{icon}</i></div><strong>{value}</strong><small>{detail}</small></div>;
}

function RecordsState({ loading, error, empty, label, description, retry }: { loading: boolean; error: string | null; empty: boolean; label: string; description: string; retry: () => void }) {
  if (loading) return <div className="empty-state"><span className="spinner" /><b>Loading records</b><small>Checking the AVOGADRO API…</small></div>;
  if (error) return <div className="empty-state"><span className="state-icon">!</span><b>Could not load records</b><small>{error}</small><button className="text-button" onClick={retry}>Try again ↻</button></div>;
  if (empty) return <div className="empty-state"><span className="state-icon">＋</span><b>{label}</b><small>{description}</small></div>;
  return null;
}

function CampaignComposer(props: { fixtureId: string; setFixtureId: (value: string) => void; seed: string; setSeed: (value: string) => void; generateSeed: () => void; runs: number; setRuns: (value: number) => void; depth: number; setDepth: (value: number) => void; timeoutSeconds: number; setTimeoutSeconds: (value: number) => void; busy: boolean; authenticated: boolean; notice: string | null; onSubmit: (event: React.FormEvent<HTMLFormElement>) => void }) {
  const replayFixture = props.fixtureId === "replay-counterexample-v1";
  return <form className="campaign-form" onSubmit={props.onSubmit}>
    <label htmlFor="fixture">TRUSTED FIXTURE</label>
    <select id="fixture" value={props.fixtureId} onChange={(event) => props.setFixtureId(event.target.value)}>
      <option value="vault-accounting-v1">Vault accounting invariant · passing fixture</option>
      <option value="replay-counterexample-v1">Replay counterexample · deliberate invariant violation</option>
    </select>
    <div className="fixture-note">{replayFixture ? "Demonstration fixture that intentionally fails a test. This is not a finding against a deployed contract." : "Repository-owned invariant fixture. Runs against local test state only."}</div>
    <label htmlFor="campaign-seed">32-BYTE SEED</label>
    <div className="input-row"><input id="campaign-seed" value={props.seed} onChange={(event) => props.setSeed(event.target.value)} placeholder="0x + 64 hex characters" pattern="0x[a-fA-F0-9]{64}" required /><button className="secondary-button" type="button" onClick={props.generateSeed}>Generate</button></div>
    <div className="limit-grid"><div><label htmlFor="campaign-runs">FUZZ RUNS</label><input id="campaign-runs" type="number" min={1} max={10000} value={props.runs} onChange={(event) => props.setRuns(Number(event.target.value))} required /></div><div><label htmlFor="campaign-depth">INVARIANT DEPTH</label><input id="campaign-depth" type="number" min={1} max={512} value={props.depth} onChange={(event) => props.setDepth(Number(event.target.value))} required /></div><div><label htmlFor="campaign-timeout">TIMEOUT (SEC)</label><input id="campaign-timeout" type="number" min={1} max={300} value={props.timeoutSeconds} onChange={(event) => props.setTimeoutSeconds(Number(event.target.value))} required /></div></div>
    <button className="primary-button launch-button" type="submit" disabled={props.busy || !props.authenticated}>{props.busy ? "Submitting…" : "Queue trusted fixture"}<span>↗</span></button>
    {!props.authenticated && <small className="fixture-note">Sign in with SIWE before creating a campaign.</small>}
    {props.notice && <div className="notice" role="status">{props.notice}</div>}
  </form>;
}

function CampaignDetail({ campaign, close, busy, onAction }: { campaign: Campaign; close: () => void; busy: boolean; onAction: (campaign: Campaign, action: "cancel" | "replay") => void }) {
  const terminal = ["completed", "passed", "failed", "cancelled", "timed_out", "error", "infrastructure_blocked"].includes(campaign.status);
  const result = campaign.result;
  const counterexample = result && (result.counterexample ?? result.counterexampleTrace ?? result.trace);
  return <div className="detail-drawer"><div className="detail-head"><div><span className="eyebrow">CAMPAIGN DETAIL</span><h3>{campaign.id}</h3></div><button className="icon-button" onClick={close} aria-label="Close campaign details">×</button></div><div className="detail-grid"><DetailValue label="STATUS" value={campaign.status} /><DetailValue label="OUTCOME" value={campaign.outcome ?? "Not reported"} /><DetailValue label="FIXTURE" value={campaign.fixtureId} /><DetailValue label="FAILURE KIND" value={campaign.failureKind ?? "None reported"} /><DetailValue label="SEED" value={campaign.seed ?? "Unavailable"} /><DetailValue label="EXECUTION DIGEST" value={campaign.executionDigest ?? "Unavailable"} /></div>
    <div className="detail-section"><b>Effective configuration</b><pre>{JSON.stringify({ invariants: campaign.selectedInvariants, runs: campaign.runs, depth: campaign.depth, timeoutSeconds: campaign.timeoutSeconds, sourceDigest: campaign.sourceDigest }, null, 2)}</pre></div>
    {result && <div className="detail-section"><b>Recorded result</b><pre>{JSON.stringify(result, null, 2)}</pre></div>}
    {counterexample !== undefined && <div className="detail-section"><b>Counterexample emitted by runner</b><pre>{JSON.stringify(counterexample, null, 2)}</pre></div>}
    {!counterexample && campaign.outcome === "failed" && <p className="fixture-note">No counterexample field was present in the recorded result.</p>}
    {campaign.attempts?.length ? <div className="detail-section"><b>Attempts ({campaign.attempts.length})</b>{campaign.attempts.map((attempt) => <div className="attempt-row" key={attempt.attemptNumber}>Attempt {attempt.attemptNumber}<span>{attempt.status}</span></div>)}</div> : null}
    <div className="detail-actions">{!terminal && <button className="secondary-button" disabled={busy || Boolean(campaign.cancelRequestedAt)} onClick={() => onAction(campaign, "cancel")}>{campaign.cancelRequestedAt ? "Cancellation requested" : "Request cancellation"}</button>}<button className="primary-button" disabled={busy || !terminal} onClick={() => onAction(campaign, "replay")}>Replay exact inputs ↻</button></div>
  </div>;
}

function DetailValue({ label, value }: { label: string; value: string }) {
  return <div className="detail-value"><small>{label}</small><b>{value}</b></div>;
}

function WorkspaceSection({ section, contracts, campaigns, loading, error, retry, fixtureId, setFixtureId, seed, setSeed, generateSeed, runs, setRuns, depth, setDepth, timeoutSeconds, setTimeoutSeconds, busy, authenticated, campaignNotice, onCreate, selectedCampaign, onOpenCampaign, onCampaignAction, onCloseCampaign }: { section: Section; contracts: ContractSummary[]; campaigns: Campaign[]; loading: boolean; error: string | null; retry: () => void; fixtureId: string; setFixtureId: (value: string) => void; seed: string; setSeed: (value: string) => void; generateSeed: () => void; runs: number; setRuns: (value: number) => void; depth: number; setDepth: (value: number) => void; timeoutSeconds: number; setTimeoutSeconds: (value: number) => void; busy: boolean; authenticated: boolean; campaignNotice: string | null; onCreate: (event: React.FormEvent<HTMLFormElement>) => void; selectedCampaign: Campaign | null; onOpenCampaign: (id: string) => void; onCampaignAction: (campaign: Campaign, action: "cancel" | "replay") => void; onCloseCampaign: () => void }) {
  const isContracts = section === "Contracts";
  const isCampaigns = section === "Campaigns";
  const isActivity = isContracts || isCampaigns;
  const heading = section === "Contracts" ? "Contract workspace" : section === "Campaigns" ? "Campaigns" : section === "Invariants" ? "Invariant library" : "Evidence artifacts";
  const desc = section === "Contracts" ? "Verified source, ABI, metadata and callable functions for imported contracts." : section === "Campaigns" ? "Immutable campaign inputs, lifecycle events, counterexamples and replay controls." : section === "Invariants" ? "Reusable property definitions for stateful Foundry campaigns." : "Reproducible manifests, logs, traces and counterexample bundles.";
  return <><div className="eyebrow"><span className="eyebrow-line" />AVOGADRO WORKSPACE <span className="eyebrow-dot">·</span> CHAIN {CHAIN_ID}</div><div className="workspace-title"><div><h1>{heading}</h1><p className="lede">{desc}</p></div><span className="subtle-tag">{isContracts ? `${contracts.length} RECORDS` : isCampaigns ? `${campaigns.length} CAMPAIGNS` : "NO DATA"}</span></div>
    {isCampaigns ? <div className="campaign-workspace"><div className="panel composer-panel"><div className="panel-head"><div><span className="step">01</span><h3>New fixture campaign</h3></div><span className="subtle-tag">ISOLATED FIXTURE</span></div><p className="panel-copy">Only reviewed repository fixtures are accepted. The API derives source identity and runs the fixed local command.</p><CampaignComposer fixtureId={fixtureId} setFixtureId={setFixtureId} seed={seed} setSeed={setSeed} generateSeed={generateSeed} runs={runs} setRuns={setRuns} depth={depth} setDepth={setDepth} timeoutSeconds={timeoutSeconds} setTimeoutSeconds={setTimeoutSeconds} busy={busy} authenticated={authenticated} notice={campaignNotice} onSubmit={onCreate} /></div><div className="panel full-panel campaign-list-panel"><div className="table-head campaign-columns"><span>CAMPAIGN / FIXTURE</span><span>STATUS</span><span>OUTCOME</span><span>DETAIL</span></div>{loading || error || campaigns.length === 0 ? <RecordsState loading={loading} error={error} empty={campaigns.length === 0} label="No campaigns yet" description="Create a trusted fixture campaign to see real worker lifecycle state here." retry={retry} /> : campaigns.map((campaign) => <div className="table-row campaign-columns" key={campaign.id}><span><b>{campaign.fixtureId}</b><small>{campaign.id}{campaign.replayOf ? ` · replay of ${campaign.replayOf}` : ""}</small></span><span><StatusDot status={campaign.status} /> {campaign.status}</span><span>{campaign.outcome ?? campaign.failureKind ?? "Pending result"}</span><span><button className="text-button" onClick={() => void onOpenCampaign(campaign.id)}>Inspect ↗</button></span></div>)}</div>{campaignNotice && <div className="notice" role="status">{campaignNotice}</div>}{selectedCampaign && <CampaignDetail campaign={selectedCampaign} close={onCloseCampaign} busy={busy} onAction={onCampaignAction} />}</div> : <div className="panel full-panel">{isActivity ? <><div className="table-head"><span>CONTRACT</span><span>NETWORK</span><span>VERIFICATION</span><span>DETAIL</span></div>{loading || error || contracts.length === 0 ? <RecordsState loading={loading} error={error} empty={contracts.length === 0} label="No contracts imported" description="Import a contract address to check its source against the configured verification provider." retry={retry} /> : contracts.map((contract) => <div className="table-row" key={contract.id}><span><b>{contract.name ?? "Unnamed contract"}</b><small>{contract.address}</small></span><span>Chain {contract.chainId}</span><span>{contract.verified ? "Verified" : contract.importStatus ?? "Verification unavailable"}</span><span className="mono">{contract.id}</span></div>)}</> : <div className="empty-state spacious"><span className="state-icon">{section === "Invariants" ? "◇" : "↗"}</span><b>{section === "Invariants" ? "Invariant templates not configured" : "No evidence artifacts"}</b><small>{section === "Invariants" ? "Templates will be shown when the API exposes supported invariant definitions. Authoring and execution are not available in this workspace yet." : "Evidence is created from completed campaign runs. No artifacts are available yet."}</small></div>}</div>}</>;
}
