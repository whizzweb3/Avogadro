"use client";

import { useCallback, useEffect, useState } from "react";
import { CHAIN_ID, type CampaignStatus } from "@avogadro/shared";

type Section = "Overview" | "Contracts" | "Campaigns" | "Invariants" | "Artifacts";
type ContractSummary = { id: string; address: string; chainId: number; status: string; name?: string };
type Campaign = { id: string; status: CampaignStatus; contractId: string; createdAt?: string };

const sections: Section[] = ["Overview", "Contracts", "Campaigns", "Invariants", "Artifacts"];
const api = "/api";

function useResource<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const response = await fetch(`${api}${path}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`Request failed (${response.status})`);
      setData(await response.json() as T);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not reach the API.");
    } finally { setLoading(false); }
  }, [path]);
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
  const { data: health, loading: healthLoading, error: healthError, reload: reloadHealth } = useResource<{ status: string; service: string }>("/health");
  const { data: contractData, loading: contractsLoading, error: contractsError, reload: reloadContracts } = useResource<{ contracts?: ContractSummary[] } | ContractSummary[]>("/v1/contracts");
  const { data: campaignData, loading: campaignsLoading, error: campaignsError, reload: reloadCampaigns } = useResource<{ campaigns?: Campaign[] } | Campaign[]>("/v1/campaigns");
  const contracts = Array.isArray(contractData) ? contractData : contractData?.contracts ?? [];
  const campaigns = Array.isArray(campaignData) ? campaignData : campaignData?.campaigns ?? [];

  async function importContract(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setNotice(null);
    try {
      const response = await fetch(`${api}/v1/contracts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chainId: CHAIN_ID, address }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error?.message ?? `Import failed (${response.status})`);
      setNotice("Import request received. Verification status will appear when the API confirms it."); setAddress(""); await reloadContracts();
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : "Import failed."); }
  }

  const contractCount = contracts.length;
  const activeCount = campaigns.filter((campaign) => campaign.status === "running" || campaign.status === "preparing").length;

  return <main className="shell">
    <aside className="sidebar">
      <a className="wordmark" href="#overview" onClick={(event) => { event.preventDefault(); setSection("Overview"); }} aria-label="AVOGADRO home"><span className="mark">A</span><span>AVOGADRO<small>SECURITY LAB</small></span></a>
      <div className="side-label">WORKSPACE</div>
      <nav aria-label="Main navigation" className="nav-list">
        {sections.map((item, index) => <button key={item} onClick={() => setSection(item)} className={`nav-item ${section === item ? "selected" : ""}`} aria-current={section === item ? "page" : undefined}><span className="nav-icon">{["◫", "⌘", "◷", "◇", "↗"][index]}</span>{item}{item === "Campaigns" && activeCount > 0 && <span className="nav-count">{activeCount}</span>}</button>)}
      </nav>
      <div className="sidebar-bottom"><div className="network-card"><span className="network-orb offline-orb" /><div><b>Robinhood Chain</b><small>CONFIGURED · {CHAIN_ID}</small></div><span className="verified-mark" aria-label="Configured chain">◌</span></div><div className="profile"><div className="avatar">L</div><div><b>Local workspace</b><small>SIWE session unavailable</small></div><span className="more">···</span></div></div>
    </aside>
    <section className="main-area">
      <header className="topbar"><div className="breadcrumb"><span>Workspace</span><i>/</i><b>{section}</b></div><div className="top-actions"><div className={`api-indicator ${healthError ? "offline" : ""}`}><StatusDot status={health?.status ?? "offline"} />{healthLoading ? "Checking API" : healthError ? "API unavailable" : "API connected"}</div><button className="icon-button" onClick={() => { void reloadHealth(); void reloadContracts(); void reloadCampaigns(); }} aria-label="Refresh data">↻</button><button className="user-chip" aria-label="Session settings">L</button></div></header>
      <div className="content">
        {section === "Overview" && <>
          <div className="eyebrow"><span className="eyebrow-line" />SECURITY WORKSPACE <span className="eyebrow-dot">·</span> CHAIN {CHAIN_ID}</div>
          <div className="hero-row"><div><h1>Contract security,<br /><em>without guesswork.</em></h1><p className="lede">Run reproducible invariant campaigns against isolated EVM forks. Every result stays traceable to its source, snapshot, and seed.</p></div><div className="hero-side"><div className="snapshot-icon">⌁</div><p>MAINNET TARGET<br /><b>RPC not configured</b></p></div></div>
          <div className="metrics"><Metric label="IMPORTED CONTRACTS" value={contractsLoading ? "—" : String(contractCount).padStart(2, "0")} detail={contractsLoading ? "Loading records" : contractsError ? "Data unavailable" : "Imported records · verification per contract"} icon="⌘" /><Metric label="ACTIVE CAMPAIGNS" value={campaignsLoading ? "—" : String(activeCount).padStart(2, "0")} detail={campaignsLoading ? "Loading records" : campaignsError ? "Data unavailable" : "API lifecycle status"} icon="◷" /><Metric label="CHAIN CONFIGURATION" value={String(CHAIN_ID)} detail="Robinhood Chain · RPC not configured" icon="◈" /><Metric label="WORKER MODE" value="LOCAL" detail="Sandbox runner unavailable" icon="▣" /></div>
          <div className="section-heading"><div><div className="eyebrow">YOUR LAB</div><h2>Start with a contract</h2></div><span className="muted">Contract verification required before testing</span></div>
          <div className="work-grid">
            <div className="panel import-panel"><div className="panel-head"><div><span className="step">01</span><h3>Import a contract</h3></div><span className="subtle-tag">VERIFICATION PROVIDER REQUIRED</span></div><p className="panel-copy">Enter a Robinhood Chain address. Import stays unavailable until a verified-source provider is configured.</p><form onSubmit={importContract}><label htmlFor="contract-address">CONTRACT ADDRESS</label><div className="input-row"><input id="contract-address" value={address} onChange={(event) => setAddress(event.target.value)} placeholder="0x…" pattern="0x[a-fA-F0-9]{40}" title="Enter a 20-byte EVM address" required /><button className="primary-button" type="submit" disabled={contractsLoading}>Check availability <span>↗</span></button></div></form>{notice && <div className="notice" role="status">{notice}</div>}<div className="secure-note"><span>◈</span> Read-only verification. No wallet connection or transaction signing.</div></div>
            <div className="panel readiness"><div className="panel-head"><div><span className="step">02</span><h3>Define an invariant</h3></div><span className="lock">⌑</span></div><p className="panel-copy">Choose a property that should remain true across every generated transaction sequence.</p><div className="template-row"><span className="template-icon">ƒ</span><span><b>Invariant harness</b><small>Foundry · Solidity</small></span><span className="arrow">↗</span></div><div className="template-row dim"><span className="template-icon">⊞</span><span><b>Supported templates</b><small>Available after contract import</small></span><span className="arrow">↗</span></div></div>
          </div>
          <div className="lower-grid"><div className="panel records-panel"><div className="section-heading compact"><div><div className="eyebrow">RECENT CONTRACTS</div><h2>Contract workspace</h2></div><button className="text-button" onClick={() => setSection("Contracts")}>View all <span>↗</span></button></div><RecordsState loading={contractsLoading} error={contractsError} empty={contractCount === 0} label="No contracts imported" description="Imported and verified contracts will appear here with their source provenance and ABI." retry={reloadContracts} /><div className="record-list">{contracts.slice(0, 3).map((contract) => <div className="record-row" key={contract.id}><span className="record-token">{(contract.name ?? "C").slice(0, 1)}</span><span className="record-name"><b>{contract.name ?? "Unnamed contract"}</b><small>{contract.address}</small></span><span className="verified-label">{contract.status}</span></div>)}</div></div>
            <div className="panel campaigns-panel"><div className="section-heading compact"><div><div className="eyebrow">CAMPAIGN ACTIVITY</div><h2>Recent runs</h2></div><button className="text-button" onClick={() => setSection("Campaigns")}>All campaigns <span>↗</span></button></div><RecordsState loading={campaignsLoading} error={campaignsError} empty={campaigns.length === 0} label="No campaigns yet" description="Campaigns appear here after an invariant run is queued." retry={reloadCampaigns} /><div className="record-list">{campaigns.slice(0, 3).map((campaign) => <div className="record-row" key={campaign.id}><span className="run-token"><StatusDot status={campaign.status} /></span><span className="record-name"><b>{campaign.id}</b><small>Contract {campaign.contractId}</small></span><span className="verified-label">{campaign.status}</span></div>)}</div></div></div>
          <footer><span>AVOGADRO <i>·</i> REPRODUCIBLE BY DESIGN</span><span>GENERATED TRANSACTIONS NEVER REACH MAINNET</span></footer>
        </>}
        {section !== "Overview" && <WorkspaceSection section={section} contracts={contracts} campaigns={campaigns} loading={section === "Contracts" ? contractsLoading : section === "Campaigns" ? campaignsLoading : false} error={section === "Contracts" ? contractsError : section === "Campaigns" ? campaignsError : null} retry={section === "Contracts" ? reloadContracts : reloadCampaigns} />}
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

function WorkspaceSection({ section, contracts, campaigns, loading, error, retry }: { section: Section; contracts: ContractSummary[]; campaigns: Campaign[]; loading: boolean; error: string | null; retry: () => void }) {
  const isContracts = section === "Contracts";
  const isCampaigns = section === "Campaigns";
  const isActivity = isContracts || isCampaigns;
  const heading = section === "Contracts" ? "Contract workspace" : section === "Campaigns" ? "Campaigns" : section === "Invariants" ? "Invariant library" : "Evidence artifacts";
  const desc = section === "Contracts" ? "Verified source, ABI, metadata and callable functions for imported contracts." : section === "Campaigns" ? "Immutable campaign inputs, lifecycle events, counterexamples and replay controls." : section === "Invariants" ? "Reusable property definitions for stateful Foundry campaigns." : "Reproducible manifests, logs, traces and counterexample bundles.";
  return <><div className="eyebrow"><span className="eyebrow-line" />AVOGADRO WORKSPACE <span className="eyebrow-dot">·</span> CHAIN {CHAIN_ID}</div><div className="workspace-title"><div><h1>{heading}</h1><p className="lede">{desc}</p></div><span className="subtle-tag">{isContracts ? `${contracts.length} RECORDS` : isCampaigns ? `${campaigns.length} CAMPAIGNS` : "NO DATA"}</span></div><div className="panel full-panel">{isActivity ? <><div className="table-head"><span>{isContracts ? "CONTRACT" : "CAMPAIGN"}</span><span>{isContracts ? "NETWORK" : "STATUS"}</span><span>{isContracts ? "VERIFICATION" : "CONTRACT"}</span><span>DETAIL</span></div>{loading || error || (isContracts ? contracts.length === 0 : campaigns.length === 0) ? <RecordsState loading={loading} error={error} empty={isContracts ? contracts.length === 0 : campaigns.length === 0} label={isContracts ? "No contracts imported" : "No campaigns queued"} description={isContracts ? "Import a contract address to check its source against the verification provider." : "Queue a campaign after selecting a verified contract and invariant harness."} retry={retry} /> : (isContracts ? contracts : campaigns).map((item) => <div className="table-row" key={item.id}><span><b>{"name" in item ? item.name ?? "Unnamed contract" : item.id}</b><small>{"address" in item ? item.address : `Contract ${item.contractId}`}</small></span><span>{"chainId" in item ? `Chain ${item.chainId}` : <><StatusDot status={item.status} /> {item.status}</>}</span><span>{"status" in item ? item.status : "—"}</span><span className="mono">{item.id}</span></div>)}</> : <div className="empty-state spacious"><span className="state-icon">{section === "Invariants" ? "◇" : "↗"}</span><b>{section === "Invariants" ? "Invariant templates not configured" : "No evidence artifacts"}</b><small>{section === "Invariants" ? "Templates will be shown when the API exposes supported invariant definitions. Authoring and execution are not available in this workspace yet." : "Evidence is created from completed campaign runs. No artifacts are available yet."}</small></div>}</div></>;
}
