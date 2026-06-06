const STORAGE_KEY = "dunscreek.localRaces";
const DEVICE_KEY = "dunscreek.deviceId";
const REMOTE_OWNED_IDS_KEY = "dunscreek.ownedRemoteRunIds";

const seedRaces = [];

const view = document.querySelector("#view");
let activeTimerFrame = null;

const publicConfig = window.DUNSCREEK_CONFIG || {};
const supabaseConfig = {
  anonKey: publicConfig.supabaseAnonKey || "",
  table: publicConfig.supabaseTable || "runs",
  url: (publicConfig.supabaseUrl || "").replace(/\/$/, ""),
};
const hasSupabase = Boolean(supabaseConfig.url && supabaseConfig.anonKey);

function getSupabaseEndpoint(query = "") {
  return `${supabaseConfig.url}/rest/v1/${supabaseConfig.table}${query}`;
}

function makeRaceKey(name, bike) {
  return `${name.trim().toLowerCase()}|${bike.trim().toLowerCase()}`;
}

function cleanupTimer() {
  if (activeTimerFrame) {
    window.cancelAnimationFrame(activeTimerFrame);
    activeTimerFrame = null;
  }
}

function readLocalRaces() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) {
      return [];
    }

    let changed = false;
    const races = parsed.filter(isRace).map((race) => {
      if (race.id) {
        return race;
      }

      changed = true;
      return { ...race, id: createRunId("local") };
    });

    if (changed) {
      writeLocalRaces(races);
    }

    return races;
  } catch {
    return [];
  }
}

function writeLocalRaces(races) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(races));
}

function getDeviceId() {
  let id = window.localStorage.getItem(DEVICE_KEY);

  if (!id) {
    id =
      window.crypto?.randomUUID?.() ||
      `device-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    window.localStorage.setItem(DEVICE_KEY, id);
  }

  return id;
}

function createRunId(prefix = "run") {
  return (
    window.crypto?.randomUUID?.() ||
    `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}

function readOwnedRemoteIds() {
  try {
    const raw = window.localStorage.getItem(REMOTE_OWNED_IDS_KEY);
    const ids = raw ? JSON.parse(raw) : [];
    return Array.isArray(ids) ? new Set(ids.map(String)) : new Set();
  } catch {
    return new Set();
  }
}

function writeOwnedRemoteIds(ids) {
  window.localStorage.setItem(REMOTE_OWNED_IDS_KEY, JSON.stringify([...ids]));
}

function markOwnedRemoteId(id) {
  if (!id) {
    return;
  }

  const ids = readOwnedRemoteIds();
  ids.add(String(id));
  writeOwnedRemoteIds(ids);
}

function unmarkOwnedRemoteId(id) {
  const ids = readOwnedRemoteIds();
  ids.delete(String(id));
  writeOwnedRemoteIds(ids);
}

function isOwnedRemoteId(id) {
  return readOwnedRemoteIds().has(String(id));
}

function normalizeRace(row) {
  const splits = [row.lap1, row.lap2, row.lap3]
    .filter((value) => value !== null && value !== undefined && value !== "")
    .map(Number);

  return {
    bike: String(row.bike || "").trim(),
    createdAt: String(row.created_at || row.createdAt || ""),
    date: String(row.race_date || row.date || "").slice(0, 10),
    id: row.id ? String(row.id) : "",
    name: String(row.name || "").trim(),
    splits,
  };
}

async function readRemoteRaces() {
  if (!hasSupabase) {
    return [];
  }

  const response = await fetch(
    getSupabaseEndpoint(
      "?select=id,name,bike,race_date,lap1,lap2,lap3,created_at&order=created_at.desc",
    ),
    {
      headers: {
        apikey: supabaseConfig.anonKey,
        Authorization: `Bearer ${supabaseConfig.anonKey}`,
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Could not load leaderboard: ${response.status}`);
  }

  const rows = await response.json();
  return rows.map(normalizeRace).filter(isRace);
}

async function writeRemoteRace(race) {
  const insertRace = async (includeDeviceId) => {
    const body = {
      bike: race.bike,
      lap1: race.splits[0],
      lap2: race.splits[1] ?? null,
      lap3: race.splits[2] ?? null,
      name: race.name,
      race_date: race.date || getTodayDate(),
    };

    if (includeDeviceId) {
      body.device_id = getDeviceId();
    }

    const response = await fetch(getSupabaseEndpoint("?select=id"), {
      body: JSON.stringify(body),
      headers: {
        apikey: supabaseConfig.anonKey,
        Authorization: `Bearer ${supabaseConfig.anonKey}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      method: "POST",
    });

    return response;
  };

  let response = await insertRace(true);
  let deviceProtected = true;

  if (!response.ok && response.status === 400) {
    const error = await response.clone().json().catch(() => null);
    if (error?.message?.includes("device_id")) {
      response = await insertRace(false);
      deviceProtected = false;
    }
  }

  if (!response.ok) {
    if (race.splits.length === 1) {
      throw new Error("Could not save single lap yet. Run the latest Supabase schema first.");
    }

    throw new Error(`Could not save time: ${response.status}`);
  }

  const rows = await response.json().catch(() => []);
  const id = rows[0]?.id ? String(rows[0].id) : "";

  if (id && deviceProtected) {
    markOwnedRemoteId(id);
  }

  return id;
}

async function deleteRemoteRace(race) {
  if (!race.id || !isOwnedRemoteId(race.id)) {
    throw new Error("This log cannot be deleted from this device.");
  }

  const response = await fetch(getSupabaseEndpoint(`?id=eq.${encodeURIComponent(race.id)}`), {
    headers: {
      apikey: supabaseConfig.anonKey,
      Authorization: `Bearer ${supabaseConfig.anonKey}`,
      "x-device-id": getDeviceId(),
    },
    method: "DELETE",
  });

  if (!response.ok) {
    throw new Error("This log cannot be deleted yet. Update the Supabase delete policy first.");
  }

  unmarkOwnedRemoteId(race.id);
}

async function deleteRaceEntry(race) {
  if (!race.id) {
    throw new Error("This log cannot be deleted.");
  }

  if (hasSupabase) {
    await deleteRemoteRace(race);
    return;
  }

  writeLocalRaces(readLocalRaces().filter((entry) => String(entry.id) !== String(race.id)));
}

function canDeleteRace(race) {
  if (!race?.id) {
    return false;
  }

  return hasSupabase ? isOwnedRemoteId(race.id) : true;
}

function isRace(race) {
  return (
    race &&
    typeof race.name === "string" &&
    typeof race.bike === "string" &&
    Array.isArray(race.splits) &&
    (race.splits.length === 1 || race.splits.length === 3) &&
    race.splits.every((value) => Number.isFinite(value) && value > 0)
  );
}

async function getAllRaces() {
  if (hasSupabase) {
    return [...seedRaces, ...(await readRemoteRaces())];
  }

  return [...seedRaces, ...readLocalRaces()];
}

function aggregateRaces(races = []) {
  const map = new Map();

  for (const race of races) {
    const key = makeRaceKey(race.name, race.bike);
    const total = getRaceTotal(race);
    const lap = getRaceBestLap(race);
    const isRaceEntry = isFullRace(race);
    const existing =
      map.get(key) ||
      {
        name: race.name.trim(),
        bike: race.bike.trim(),
        bestLap: Number.POSITIVE_INFINITY,
        bestLapDate: "",
        bestRaceTotal: Number.POSITIVE_INFINITY,
        bestRaceDate: "",
        bestRaceSplits: [],
        runs: 0,
      };

    existing.runs += 1;

    if (lap < existing.bestLap) {
      existing.bestLap = lap;
      existing.bestLapDate = race.date || "";
    }

    if (isRaceEntry && total < existing.bestRaceTotal) {
      existing.bestRaceTotal = total;
      existing.bestRaceDate = race.date || "";
      existing.bestRaceSplits = [...race.splits];
    }

    map.set(key, existing);
  }

  return [...map.values()].sort((a, b) => a.bestLap - b.bestLap);
}

function findPersonalBest(name, bike, races = []) {
  const key = makeRaceKey(name, bike);
  return aggregateRaces(races).find((row) => makeRaceKey(row.name, row.bike) === key);
}

function formatLap(value) {
  return value.toFixed(3);
}

function formatDelta(value) {
  if (Math.abs(value) < 0.0005) {
    return "0.000";
  }

  return `${value > 0 ? "+" : "-"}${Math.abs(value).toFixed(3)}`;
}

function formatRace(value) {
  const minutes = Math.floor(value / 60);
  const seconds = value - minutes * 60;
  return `${minutes}:${seconds.toFixed(3).padStart(6, "0")}`;
}

function getRaceTotal(race) {
  return race.splits.reduce((sum, split) => sum + split, 0);
}

function getRaceBestLap(race) {
  return Math.min(...race.splits);
}

function isFullRace(race) {
  return race.splits.length === 3;
}

function formatEntryTime(race) {
  return isFullRace(race) ? formatRace(getRaceTotal(race)) : formatLap(getRaceBestLap(race));
}

function getEntryType(race) {
  return isFullRace(race) ? "Race" : "Lap";
}

function getSplitDeltaTone(delta) {
  if (delta < -0.0005) {
    return "is-faster";
  }

  if (delta > 0.0005) {
    return "is-slower";
  }

  return "is-even";
}

function renderSplitDelta(split, baseline, lapNumber) {
  if (!Number.isFinite(split) || !Number.isFinite(baseline)) {
    return "";
  }

  const delta = split - baseline;
  const tone = getSplitDeltaTone(delta);
  const readable =
    tone === "is-faster"
      ? `${formatDelta(delta)} faster than PB lap ${lapNumber}`
      : tone === "is-slower"
        ? `${formatDelta(delta)} slower than PB lap ${lapNumber}`
        : `Even with PB lap ${lapNumber}`;

  return `
    <small class="split-delta ${tone}" aria-label="${escapeAttribute(readable)}">
      ${formatDelta(delta)}
      <span>vs PB ${formatLap(baseline)}</span>
    </small>
  `;
}

function formatDate(value) {
  if (!value) {
    return "-";
  }

  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("en-AU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

function getPlaceLabel(rank) {
  if (rank === 1) {
    return "1st place";
  }

  if (rank === 2) {
    return "2nd place";
  }

  if (rank === 3) {
    return "3rd place";
  }

  return `${rank}th place`;
}

function renderRank(rank) {
  const podium = [
    { name: "Gold", tone: "gold" },
    { name: "Silver", tone: "silver" },
    { name: "Bronze", tone: "bronze" },
  ][rank - 1];

  if (!podium) {
    return String(rank);
  }

  return `
    <span class="rank-badge rank-badge-${podium.tone}" aria-label="${podium.name} trophy, ${getPlaceLabel(rank)}">
      <svg class="rank-trophy" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"></path>
        <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"></path>
        <path d="M4 22h16"></path>
        <path d="M10 14.7V17c0 .6-.5 1-1 1.2C7.9 18.8 7 20.2 7 22"></path>
        <path d="M14 14.7V17c0 .6.5 1 1 1.2 1.1.6 2 2 2 3.8"></path>
        <path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"></path>
      </svg>
      <span aria-hidden="true">${rank}</span>
    </span>
  `;
}

function getTodayDate() {
  return new Date().toISOString().slice(0, 10);
}

function getRaceSortValue(race) {
  const dateValue = Date.parse(`${race.date || ""}T00:00:00`);
  const createdValue = Date.parse(race.createdAt || "");

  if (Number.isFinite(dateValue) && Number.isFinite(createdValue)) {
    return dateValue + createdValue % 86400000;
  }

  if (Number.isFinite(dateValue)) {
    return dateValue;
  }

  if (Number.isFinite(createdValue)) {
    return createdValue;
  }

  return 0;
}

function formatClock(milliseconds) {
  const totalSeconds = Math.max(0, milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${minutes}:${seconds.toFixed(2).padStart(5, "0")}`;
}

function parseTime(value) {
  const clean = value.trim();

  if (!clean) {
    return Number.NaN;
  }

  if (clean.includes(":")) {
    const parts = clean.split(":").map((part) => part.trim());
    if (parts.length !== 2) {
      return Number.NaN;
    }

    const minutes = Number(parts[0]);
    const seconds = Number(parts[1]);
    return Number.isFinite(minutes) && Number.isFinite(seconds)
      ? minutes * 60 + seconds
      : Number.NaN;
  }

  return Number(clean);
}

function getBestMessage(race, previous) {
  const total = getRaceTotal(race);
  const bestLap = getRaceBestLap(race);
  const isRaceEntry = isFullRace(race);

  if (!previous) {
    return isRaceEntry
      ? `First run saved for ${race.name}: ${formatRace(total)}.`
      : `First lap saved for ${race.name}: ${formatLap(bestLap)}.`;
  }

  const beatRace = isRaceEntry && total < previous.bestRaceTotal;
  const beatLap = bestLap < previous.bestLap;

  if (beatRace && beatLap) {
    return `New personal best race and lap: ${formatRace(total)} / ${formatLap(bestLap)}.`;
  }

  if (beatRace) {
    return `New personal best race: ${formatRace(total)}.`;
  }

  if (beatLap) {
    return `New personal best lap: ${formatLap(bestLap)}.`;
  }

  if (!isRaceEntry) {
    return `Lap saved: ${formatLap(bestLap)}. Best remains ${formatLap(previous.bestLap)}.`;
  }

  return Number.isFinite(previous.bestRaceTotal)
    ? `Run saved: ${formatRace(total)}. Best remains ${formatRace(previous.bestRaceTotal)}.`
    : `Run saved: ${formatRace(total)}.`;
}

async function getSaveResult(race) {
  const previousRaces = await getAllRaces();
  const previousPersonal = findPersonalBest(race.name, race.bike, previousRaces);
  const previousRows = aggregateRaces(previousRaces);
  const previousBikeRows = previousRows.filter(
    (row) => row.bike.trim().toLowerCase() === race.bike.trim().toLowerCase(),
  );
  const total = getRaceTotal(race);
  const bestLap = getRaceBestLap(race);
  const isRaceEntry = isFullRace(race);
  const previousTrackLap = previousRows[0]?.bestLap ?? Number.POSITIVE_INFINITY;
  const previousTrackRace = previousRows.reduce(
    (best, row) =>
      Number.isFinite(row.bestRaceTotal) ? Math.min(best, row.bestRaceTotal) : best,
    Number.POSITIVE_INFINITY,
  );
  const previousBikeLap = previousBikeRows.reduce(
    (best, row) => Math.min(best, row.bestLap),
    Number.POSITIVE_INFINITY,
  );
  const previousBikeRace = previousBikeRows.reduce(
    (best, row) =>
      Number.isFinite(row.bestRaceTotal) ? Math.min(best, row.bestRaceTotal) : best,
    Number.POSITIVE_INFINITY,
  );
  const alerts = [];

  if (previousPersonal) {
    const beatRace = isRaceEntry && total < previousPersonal.bestRaceTotal;
    const beatLap = bestLap < previousPersonal.bestLap;

    if (beatRace && beatLap) {
      alerts.push({
        detail: `${formatRace(total)} race / ${formatLap(bestLap)} lap`,
        title: "Rider-bike PR: race and lap",
        type: "pr",
      });
    } else if (beatRace) {
      alerts.push({
        detail: `${formatRace(total)} three-lap race`,
        title: "Rider-bike PR: race",
        type: "pr",
      });
    } else if (beatLap) {
      alerts.push({
        detail: `${formatLap(bestLap)} best lap`,
        title: "Rider-bike PR: lap",
        type: "pr",
      });
    }
  }

  if (!previousRows.length) {
    alerts.push({
      detail: isRaceEntry
        ? `${formatLap(bestLap)} lap / ${formatRace(total)} race`
        : `${formatLap(bestLap)} lap`,
      title: isRaceEntry ? "First track records set" : "First track lap record",
      type: "track",
    });
  } else {
    const beatTrackLap = bestLap < previousTrackLap;
    const beatTrackRace = isRaceEntry && total < previousTrackRace;

    if (beatTrackLap && beatTrackRace) {
      alerts.push({
        detail: `${formatLap(bestLap)} lap / ${formatRace(total)} race`,
        title: "New track lap and race record",
        type: "track",
      });
    } else if (beatTrackLap) {
      alerts.push({
        detail: `${formatLap(bestLap)} best lap`,
        title: "New track lap record",
        type: "track",
      });
    } else if (beatTrackRace) {
      alerts.push({
        detail: `${formatRace(total)} three-lap race`,
        title: "New track race record",
        type: "track",
      });
    }
  }

  if (!previousBikeRows.length) {
    alerts.push({
      detail: isRaceEntry
        ? `${race.bike} / ${formatLap(bestLap)} lap / ${formatRace(total)} race`
        : `${race.bike} / ${formatLap(bestLap)} lap`,
      title: isRaceEntry ? "First bike records set" : "First bike lap record",
      type: "bike",
    });
  } else {
    const beatBikeLap = bestLap < previousBikeLap;
    const beatBikeRace = isRaceEntry && total < previousBikeRace;

    if (beatBikeLap && beatBikeRace) {
      alerts.push({
        detail: `${race.bike} / ${formatLap(bestLap)} lap / ${formatRace(total)} race`,
        title: "New bike lap and race record",
        type: "bike",
      });
    } else if (beatBikeLap) {
      alerts.push({
        detail: `${race.bike} / ${formatLap(bestLap)} best lap`,
        title: "New bike lap record",
        type: "bike",
      });
    } else if (beatBikeRace) {
      alerts.push({
        detail: `${race.bike} / ${formatRace(total)} three-lap race`,
        title: "New bike race record",
        type: "bike",
      });
    }
  }

  return {
    alerts,
    status: getBestMessage(race, previousPersonal),
  };
}

async function saveRaceEntry(race) {
  if (!isRace(race)) {
    return { alerts: [], status: "" };
  }

  const result = await getSaveResult(race);

  if (hasSupabase) {
    await writeRemoteRace(race);
  } else {
    const localRaces = readLocalRaces();
    localRaces.unshift({ ...race, createdAt: new Date().toISOString(), id: createRunId("local") });
    writeLocalRaces(localRaces);
  }

  return result;
}

async function renderRoute() {
  cleanupTimer();
  const route = window.location.hash.replace("#", "") || "home";

  document.querySelectorAll("[data-route-link]").forEach((link) => {
    link.classList.toggle("is-active", link.dataset.routeLink === route);
  });

  try {
    if (route === "leaderboard") {
      await renderLeaderboardPage();
      return;
    }

    if (route === "log") {
      await renderLogPage();
      return;
    }

    await renderHomePage();
  } catch (error) {
    view.innerHTML = `
      <section class="detail-grid">
        <div class="form-panel">
          <p class="eyebrow">Connection</p>
          <h1>Leaderboard Offline</h1>
          <p class="status">${escapeHtml(error.message || "Could not load the public leaderboard.")}</p>
        </div>
      </section>
    `;
  }
}

async function renderHomePage() {
  const rows = aggregateRaces(await getAllRaces());

  view.innerHTML = `
    <section class="hero-board" aria-labelledby="all-time-heading">
      <div class="board-panel">
        <div class="board-header">
          <div>
            <p class="eyebrow">All time</p>
            <h1 id="all-time-heading">Leaderboard</h1>
          </div>
          <div class="board-controls">
            <div class="mode-toggle" role="group" aria-label="Leaderboard type">
              <button class="mode-button is-active" type="button" data-home-mode="lap" aria-pressed="true">Lap</button>
              <button class="mode-button" type="button" data-home-mode="race" aria-pressed="false">Race</button>
            </div>
            <div class="board-meta" aria-label="Leaderboard stats">
              <div class="metric">
                <strong>${rows.length}</strong>
                <span>Riders</span>
              </div>
              <div class="metric">
                <strong id="home-best-time">-</strong>
                <span id="home-best-label">Best lap</span>
              </div>
            </div>
          </div>
        </div>
        <div class="table-wrap">
          <table class="leaderboard-table all-time-table">
            <thead>
              <tr>
                <th scope="col">Rank</th>
                <th scope="col">Name</th>
                <th scope="col" id="home-time-heading">Lap time</th>
                <th scope="col">Bike</th>
                <th scope="col">Date</th>
              </tr>
            </thead>
            <tbody id="home-leaderboard-rows"></tbody>
          </table>
        </div>
      </div>
    </section>
  `;

  const modeButtons = document.querySelectorAll("[data-home-mode]");
  const rowsTarget = document.querySelector("#home-leaderboard-rows");
  const bestTime = document.querySelector("#home-best-time");
  const bestLabel = document.querySelector("#home-best-label");
  const timeHeading = document.querySelector("#home-time-heading");
  const renderHomeRows = (mode) => {
    const isRaceMode = mode === "race";
    const sortedRows = [...rows]
      .filter((row) =>
        isRaceMode ? Number.isFinite(row.bestRaceTotal) : Number.isFinite(row.bestLap),
      )
      .sort((a, b) =>
        isRaceMode ? a.bestRaceTotal - b.bestRaceTotal : a.bestLap - b.bestLap,
      );
    const fastest = sortedRows[0];

    bestTime.textContent = fastest
      ? isRaceMode
        ? formatRace(fastest.bestRaceTotal)
        : formatLap(fastest.bestLap)
      : "-";
    bestLabel.textContent = isRaceMode ? "Best race" : "Best lap";
    timeHeading.textContent = isRaceMode ? "Race time" : "Lap time";
    rowsTarget.innerHTML = sortedRows.length
      ? sortedRows.map((row, index) => renderAllTimeRow(row, index, mode)).join("")
      : `<tr><td colspan="5" class="empty-state">${isRaceMode ? "No race times logged yet." : "No lap times logged yet."}</td></tr>`;

    modeButtons.forEach((button) => {
      const active = button.dataset.homeMode === mode;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  };

  modeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      renderHomeRows(button.dataset.homeMode);
    });
  });
  renderHomeRows("lap");
}

function renderAllTimeRow(row, index, mode = "lap") {
  const isRaceMode = mode === "race";
  const time = isRaceMode ? formatRace(row.bestRaceTotal) : formatLap(row.bestLap);
  const date = isRaceMode ? row.bestRaceDate : row.bestLapDate;
  const label = isRaceMode ? "Race" : "Lap";

  return `
    <tr>
      <td class="rank" data-label="Rank">${renderRank(index + 1)}</td>
      <td class="name-cell" data-label="Name">${escapeHtml(row.name)}</td>
      <td class="time-cell" data-label="${label}">${time}</td>
      <td data-label="Bike"><span class="bike-pill">${escapeHtml(row.bike)}</span></td>
      <td class="date-cell" data-label="Date">${formatDate(date)}</td>
    </tr>
  `;
}

async function renderLeaderboardPage() {
  const allRaces = await getAllRaces();
  const rows = aggregateRaces(allRaces).sort(
    (a, b) => a.bestRaceTotal - b.bestRaceTotal,
  );
  const bikes = [...new Set(rows.map((row) => row.bike))].sort((a, b) =>
    a.localeCompare(b),
  );

  view.innerHTML = `
    <section class="detail-grid" aria-labelledby="detail-heading">
      <div class="page-header">
        <div>
          <p class="eyebrow">Three lap pace</p>
          <h1 id="detail-heading">Leaderboard</h1>
        </div>
        <div class="filters" aria-label="Leaderboard filters">
          <div class="field">
            <label for="user-filter">User</label>
            <input id="user-filter" type="search" placeholder="Rider name">
          </div>
          <div class="field">
            <label for="bike-filter">Bike</label>
            <select id="bike-filter">
              <option value="">All bikes</option>
              ${bikes.map((bike) => `<option value="${escapeAttribute(bike)}">${escapeHtml(bike)}</option>`).join("")}
            </select>
          </div>
          <div class="field">
            <label for="date-filter">Date</label>
            <input id="date-filter" type="date">
          </div>
        </div>
      </div>

      <div class="board-panel">
        <div class="table-wrap">
          <table class="leaderboard-table detailed-table">
            <thead>
              <tr>
                <th scope="col">Rank</th>
                <th scope="col">Name</th>
                <th scope="col">Bike</th>
                <th scope="col">Best race</th>
                <th scope="col">Date</th>
                <th scope="col">Lap splits</th>
                <th scope="col">Best lap</th>
              </tr>
            </thead>
            <tbody id="detail-rows"></tbody>
          </table>
        </div>
      </div>

      <div class="board-panel rider-history-panel" id="rider-history-panel" hidden>
        <div class="history-header">
          <div>
            <p class="eyebrow">Rider history</p>
            <h2 id="history-heading">Run history</h2>
          </div>
          <div class="history-summary" id="history-summary" aria-label="Rider history stats"></div>
        </div>
        <div class="history-chart" id="history-chart"></div>
        <div class="table-wrap">
          <table class="leaderboard-table history-table">
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Rider</th>
                <th scope="col">Bike</th>
                <th scope="col">Type</th>
                <th scope="col">Time</th>
                <th scope="col">Lap splits</th>
              </tr>
            </thead>
            <tbody id="history-rows"></tbody>
          </table>
        </div>
      </div>
    </section>
  `;

  const userFilter = document.querySelector("#user-filter");
  const bikeFilter = document.querySelector("#bike-filter");
  const dateFilter = document.querySelector("#date-filter");
  const historyPanel = document.querySelector("#rider-history-panel");
  const historyHeading = document.querySelector("#history-heading");
  const historySummary = document.querySelector("#history-summary");
  const historyChart = document.querySelector("#history-chart");
  const historyRows = document.querySelector("#history-rows");

  const renderHistory = (userQuery, bike, date) => {
    if (!userQuery) {
      historyPanel.hidden = true;
      return;
    }

    const matchedRaces = allRaces
      .filter((race) => {
        const matchesUser = race.name.toLowerCase().includes(userQuery);
        const matchesBike = !bike || race.bike === bike;
        const matchesDate = !date || race.date === date;
        return matchesUser && matchesBike && matchesDate;
      })
      .sort((a, b) => getRaceSortValue(a) - getRaceSortValue(b));

    const riderNames = [...new Set(matchedRaces.map((race) => race.name))].sort((a, b) =>
      a.localeCompare(b),
    );
    const bestRace = matchedRaces.reduce(
      (best, race) => Math.min(best, getRaceTotal(race)),
      Number.POSITIVE_INFINITY,
    );
    const bestLap = matchedRaces.reduce(
      (best, race) => Math.min(best, getRaceBestLap(race)),
      Number.POSITIVE_INFINITY,
    );

    historyPanel.hidden = false;
    historyHeading.textContent =
      riderNames.length === 1 ? `${riderNames[0]} history` : "Rider history";
    historySummary.innerHTML = `
      <div>
        <strong>${matchedRaces.length}</strong>
        <span>Runs</span>
      </div>
      <div>
        <strong>${Number.isFinite(bestRace) ? formatRace(bestRace) : "-"}</strong>
        <span>Best race</span>
      </div>
      <div>
        <strong>${Number.isFinite(bestLap) ? formatLap(bestLap) : "-"}</strong>
        <span>Best lap</span>
      </div>
    `;
    historyChart.innerHTML = matchedRaces.length
      ? renderHistoryChart(matchedRaces)
      : `<div class="history-empty">No logged times match this rider.</div>`;
    historyRows.innerHTML = matchedRaces.length
      ? [...matchedRaces].reverse().map(renderHistoryRow).join("")
      : `<tr><td colspan="6" class="empty-state">No logged times match this rider.</td></tr>`;
  };

  const renderRows = () => {
    const userQuery = userFilter.value.trim().toLowerCase();
    const bike = bikeFilter.value;
    const date = dateFilter.value;
    const filteredRows = rows.filter((row) => {
      const matchesUser = row.name.toLowerCase().includes(userQuery);
      const matchesBike = !bike || row.bike === bike;
      const matchesDate = !date || row.bestRaceDate === date || row.bestLapDate === date;
      return Number.isFinite(row.bestRaceTotal) && matchesUser && matchesBike && matchesDate;
    });

    document.querySelector("#detail-rows").innerHTML = filteredRows.length
      ? filteredRows.map(renderDetailedRow).join("")
      : `<tr><td colspan="7" class="empty-state">No times match those filters.</td></tr>`;
    renderHistory(userQuery, bike, date);
  };

  userFilter.addEventListener("input", renderRows);
  bikeFilter.addEventListener("change", renderRows);
  dateFilter.addEventListener("change", renderRows);
  renderRows();
}

function renderHistoryChart(races) {
  const width = 760;
  const height = 236;
  const inset = {
    bottom: 42,
    left: 64,
    right: 22,
    top: 24,
  };
  const plotWidth = width - inset.left - inset.right;
  const plotHeight = height - inset.top - inset.bottom;
  const laps = races.map(getRaceBestLap);
  const fastest = Math.min(...laps);
  const slowest = Math.max(...laps);
  const spread = Math.max(1, slowest - fastest);
  const domainMin = fastest - spread * 0.08;
  const domainMax = slowest + spread * 0.08;
  const pointRows = races.map((race, index) => {
    const lap = getRaceBestLap(race);
    const x =
      races.length === 1
        ? inset.left + plotWidth / 2
        : inset.left + (plotWidth * index) / (races.length - 1);
    const y =
      inset.top + ((lap - domainMin) / Math.max(1, domainMax - domainMin)) * plotHeight;

    return { lap, race, x, y };
  });
  const linePoints = pointRows.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const areaPoints = `${inset.left},${height - inset.bottom} ${linePoints} ${width - inset.right},${height - inset.bottom}`;
  const bestLap = Math.min(...pointRows.map((point) => point.lap));
  const firstDate = formatDate(races[0].date);
  const lastDate = formatDate(races[races.length - 1].date);

  return `
    <div class="history-chart-title">
      <strong>Lap time trend</strong>
      <span>Lower is faster</span>
    </div>
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Lap time trend by date">
      <line class="history-grid-line" x1="${inset.left}" y1="${inset.top}" x2="${width - inset.right}" y2="${inset.top}"></line>
      <line class="history-grid-line" x1="${inset.left}" y1="${height - inset.bottom}" x2="${width - inset.right}" y2="${height - inset.bottom}"></line>
      <text class="history-axis-label" x="8" y="${inset.top + 5}">${formatLap(fastest)}</text>
      <text class="history-axis-label" x="8" y="${height - inset.bottom + 5}">${formatLap(slowest)}</text>
      <polygon class="history-chart-area" points="${areaPoints}"></polygon>
      <polyline class="history-chart-line" points="${linePoints}"></polyline>
      ${pointRows
        .map(
          (point) => `
            <circle
              class="history-chart-point ${point.lap === bestLap ? "is-best" : ""}"
              cx="${point.x.toFixed(1)}"
              cy="${point.y.toFixed(1)}"
              r="${point.lap === bestLap ? 7 : 5}"
            >
              <title>${formatDate(point.race.date)} / ${formatLap(point.lap)}</title>
            </circle>
          `,
        )
        .join("")}
      <text class="history-date-label" x="${inset.left}" y="${height - 10}">${firstDate}</text>
      <text class="history-date-label" x="${width - inset.right}" y="${height - 10}" text-anchor="end">${lastDate}</text>
    </svg>
  `;
}

function renderDetailedRow(row, index) {
  return `
    <tr>
      <td class="rank" data-label="Rank">${renderRank(index + 1)}</td>
      <td class="name-cell" data-label="Name">${escapeHtml(row.name)}</td>
      <td data-label="Bike"><span class="bike-pill">${escapeHtml(row.bike)}</span></td>
      <td class="time-cell" data-label="Best race">${formatRace(row.bestRaceTotal)}</td>
      <td class="date-cell" data-label="Date">${formatDate(row.bestRaceDate)}</td>
      <td data-label="Splits">
        <div class="split-list" aria-label="Best race lap splits">
          ${row.bestRaceSplits.map((split) => `<span>${formatLap(split)}</span>`).join("")}
        </div>
      </td>
      <td class="time-cell" data-label="Best lap">${formatLap(row.bestLap)}</td>
    </tr>
  `;
}

function renderHistoryRow(race) {
  return `
    <tr>
      <td class="date-cell" data-label="Date">${formatDate(race.date)}</td>
      <td class="name-cell" data-label="Rider">${escapeHtml(race.name)}</td>
      <td data-label="Bike"><span class="bike-pill">${escapeHtml(race.bike)}</span></td>
      <td data-label="Type"><span class="entry-type-pill">${getEntryType(race)}</span></td>
      <td class="time-cell" data-label="Time">${formatEntryTime(race)}</td>
      <td data-label="Splits">
        <div class="split-list" aria-label="Logged lap splits">
          ${race.splits.map((split) => `<span>${formatLap(split)}</span>`).join("")}
        </div>
      </td>
    </tr>
  `;
}

async function renderLogPage() {
  const today = getTodayDate();
  let currentRows = aggregateRaces(await getAllRaces());

  view.innerHTML = `
    <section class="detail-grid" aria-labelledby="log-heading">
      <div class="page-header">
        <div>
          <p class="eyebrow">Duns Creek Invitational</p>
          <h1 id="log-heading">Log</h1>
        </div>
      </div>

      <form class="form-panel" id="time-form">
        <div class="form-grid">
          <div class="field">
            <label for="rider-name">Rider</label>
            <input id="rider-name" name="name" autocomplete="name" required>
          </div>
          <div class="field">
            <label for="bike-name">Bike</label>
            <input id="bike-name" name="bike" list="bike-options" required>
            <datalist id="bike-options">
              ${[...new Set(currentRows.map((row) => row.bike))]
                .sort((a, b) => a.localeCompare(b))
                .map((bike) => `<option value="${escapeAttribute(bike)}"></option>`)
                .join("")}
            </datalist>
          </div>
          <div class="field">
            <label for="race-date">Date</label>
            <input id="race-date" name="date" type="date" value="${today}" required>
          </div>
        </div>

        <div class="timer-panel" aria-label="Race timer">
          <div class="timer-face">
            <span>Clock</span>
            <output id="timer-display">0:00.00</output>
          </div>

          <div class="timer-controls">
            <button class="action-button" id="start-button" type="button">Start</button>
            <button class="ghost-button stop-button" id="stop-button" type="button" disabled>Stop</button>
            <button class="ghost-button" id="lap-button" type="button" disabled>Lap</button>
            <button class="ghost-button save-lap-button" id="save-lap-button" type="button" disabled>Save Lap</button>
            <button class="ghost-button" id="reset-button" type="button">Reset</button>
          </div>
        </div>

        <div class="split-board" aria-label="Lap splits" id="split-board"></div>

        <div class="form-actions timer-status-row">
          <p class="status" id="form-status" role="status"></p>
        </div>

        <div class="record-alert-list" id="timer-record-alerts" aria-live="polite" hidden></div>

        <div class="recent-list" id="recent-list"></div>
      </form>

      <form class="form-panel manual-panel" id="manual-form">
        <div class="manual-heading">
          <p class="eyebrow">Manual entry</p>
          <h2>Manual Time</h2>
        </div>

        <div class="form-grid">
          <div class="field">
            <label for="manual-rider-name">Rider</label>
            <input id="manual-rider-name" name="name" autocomplete="name" required>
          </div>
          <div class="field">
            <label for="manual-bike-name">Bike</label>
            <input id="manual-bike-name" name="bike" list="bike-options" required>
          </div>
          <div class="field">
            <label for="manual-race-date">Date</label>
            <input id="manual-race-date" name="date" type="date" value="${today}" required>
          </div>
          <div class="field field-wide">
            <label>Lap splits</label>
            <div class="split-inputs">
              <input name="lap1" inputmode="decimal" placeholder="Lap 1" required>
              <input name="lap2" inputmode="decimal" placeholder="Lap 2 (race)">
              <input name="lap3" inputmode="decimal" placeholder="Lap 3 (race)">
            </div>
          </div>
        </div>

        <div class="form-actions">
          <button class="action-button" type="submit">
            <span aria-hidden="true">+</span>
            Save Time
          </button>
          <p class="status" id="manual-status" role="status"></p>
        </div>

        <div class="record-alert-list" id="manual-record-alerts" aria-live="polite" hidden></div>
      </form>
    </section>
  `;

  const form = document.querySelector("#time-form");
  const status = document.querySelector("#form-status");
  const timerDisplay = document.querySelector("#timer-display");
  const splitBoard = document.querySelector("#split-board");
  const startButton = document.querySelector("#start-button");
  const stopButton = document.querySelector("#stop-button");
  const lapButton = document.querySelector("#lap-button");
  const saveLapButton = document.querySelector("#save-lap-button");
  const resetButton = document.querySelector("#reset-button");
  const timerRecordAlerts = document.querySelector("#timer-record-alerts");
  const manualForm = document.querySelector("#manual-form");
  const manualStatus = document.querySelector("#manual-status");
  const manualRecordAlerts = document.querySelector("#manual-record-alerts");
  const timer = {
    elapsedBeforeStart: 0,
    lastLapElapsed: 0,
    running: false,
    saved: false,
    splits: [],
    startedAt: 0,
  };

  const currentElapsed = () =>
    timer.running
      ? timer.elapsedBeforeStart + performance.now() - timer.startedAt
      : timer.elapsedBeforeStart;

  const updateClock = () => {
    timerDisplay.value = formatClock(currentElapsed());
    if (timer.running) {
      activeTimerFrame = window.requestAnimationFrame(updateClock);
    }
  };

  const refreshCurrentRows = async () => {
    currentRows = aggregateRaces(await getAllRaces());
  };

  const getComparisonSplits = () => {
    const data = new FormData(form);
    const name = String(data.get("name")).trim();
    const bike = String(data.get("bike")).trim();

    if (!name || !bike) {
      return [];
    }

    const personalBest = currentRows.find(
      (row) => makeRaceKey(row.name, row.bike) === makeRaceKey(name, bike),
    );

    return personalBest?.bestRaceSplits?.length === 3 ? personalBest.bestRaceSplits : [];
  };

  const setButtons = () => {
    const complete = timer.splits.length >= 3;
    startButton.disabled = timer.running || complete || timer.saved;
    stopButton.disabled = !timer.running;
    lapButton.disabled = !timer.running || complete || timer.saved;
    saveLapButton.disabled = timer.splits.length !== 1 || timer.saved;
    resetButton.disabled = false;
  };

  const renderSplits = () => {
    const comparisonSplits = getComparisonSplits();
    splitBoard.innerHTML = [0, 1, 2]
      .map((index) => {
        const split = timer.splits[index];
        const isFilled = Number.isFinite(split);
        return `
          <div class="split-card ${isFilled ? "is-filled" : ""}">
            <span>Lap ${index + 1}</span>
            <strong>${isFilled ? formatLap(split) : "--"}</strong>
            ${renderSplitDelta(split, comparisonSplits[index], index + 1)}
          </div>
        `;
      })
      .join("");
  };

  const renderRecordAlerts = (container, result) => {
    if (!result.alerts.length) {
      container.hidden = true;
      container.innerHTML = "";
      return;
    }

    container.hidden = false;
    container.innerHTML = result.alerts
      .map(
        (alert) => `
          <div class="record-alert record-alert-${alert.type}">
            <span>Record alert</span>
            <strong>${escapeHtml(alert.title)}</strong>
            <p>${escapeHtml(alert.detail)}</p>
          </div>
        `,
      )
      .join("");
  };

  const getRaceDraft = () => {
    const data = new FormData(form);
    return {
      name: String(data.get("name")).trim(),
      bike: String(data.get("bike")).trim(),
      splits: [...timer.splits],
      date: String(data.get("date") || getTodayDate()),
    };
  };

  const saveRace = async () => {
    const race = getRaceDraft();

    if (!isRace(race)) {
      status.textContent = "Record one lap or three laps before saving.";
      return;
    }

    timer.saved = true;
    status.textContent = "Saving time...";
    renderRecordAlerts(timerRecordAlerts, { alerts: [] });

    try {
      const result = await saveRaceEntry(race);
      status.textContent = result.status;
      renderRecordAlerts(timerRecordAlerts, result);
      await renderRecentEntries();
      await refreshCurrentRows();
      setButtons();
    } catch (error) {
      timer.saved = false;
      status.textContent = error.message || "Could not save this time.";
      setButtons();
    }
  };

  const saveSingleLap = async () => {
    if (timer.splits.length !== 1 || timer.saved) {
      status.textContent = "Record one lap first.";
      return;
    }

    stopTimer();
    await saveRace();
  };

  const stopTimer = () => {
    if (!timer.running) {
      return;
    }

    timer.elapsedBeforeStart = currentElapsed();
    timer.running = false;
    window.cancelAnimationFrame(activeTimerFrame);
    activeTimerFrame = null;
    updateClock();
  };

  const resetTimer = () => {
    stopTimer();
    timer.elapsedBeforeStart = 0;
    timer.lastLapElapsed = 0;
    timer.saved = false;
    timer.splits = [];
    timerDisplay.value = "0:00.00";
    status.textContent = "";
    renderRecordAlerts(timerRecordAlerts, { alerts: [] });
    renderSplits();
    setButtons();
  };

  const validateRider = () => {
    if (!form.reportValidity()) {
      status.textContent = "Add the rider and bike first.";
      return false;
    }

    return true;
  };

  const recordLap = () => {
    if (!validateRider() || timer.splits.length >= 3) {
      return false;
    }

    const elapsed = currentElapsed();
    const lapSeconds = Number(((elapsed - timer.lastLapElapsed) / 1000).toFixed(3));

    if (lapSeconds <= 0) {
      return false;
    }

    timer.splits.push(lapSeconds);
    timer.lastLapElapsed = elapsed;
    renderSplits();

    if (timer.splits.length === 3) {
      stopTimer();
      saveRace();
      return true;
    }

    status.textContent =
      timer.splits.length === 1
        ? "Save this lap or keep going for a three-lap race."
        : "1 lap left.";
    setButtons();
    return true;
  };

  startButton.addEventListener("click", () => {
    if (!validateRider() || timer.running || timer.splits.length >= 3) {
      return;
    }

    timer.running = true;
    timer.saved = false;
    timer.startedAt = performance.now();
    status.textContent = "";
    updateClock();
    setButtons();
  });

  stopButton.addEventListener("click", () => {
    const hadOpenLap = currentElapsed() > timer.lastLapElapsed;
    stopTimer();

    if (hadOpenLap && timer.splits.length < 3) {
      recordLap();
      return;
    }

    setButtons();
  });

  lapButton.addEventListener("click", () => {
    recordLap();
  });

  saveLapButton.addEventListener("click", saveSingleLap);

  resetButton.addEventListener("click", resetTimer);

  manualForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const data = new FormData(manualForm);
    const race = {
      name: String(data.get("name")).trim(),
      bike: String(data.get("bike")).trim(),
      splits: ["lap1", "lap2", "lap3"]
        .map((key) => String(data.get(key)).trim())
        .filter(Boolean)
        .map(parseTime),
      date: String(data.get("date") || getTodayDate()),
    };

    if (!isRace(race)) {
      manualStatus.textContent = "Enter one lap or all three lap times.";
      renderRecordAlerts(manualRecordAlerts, { alerts: [] });
      return;
    }

    manualStatus.textContent = "Saving time...";
    renderRecordAlerts(manualRecordAlerts, { alerts: [] });

    try {
      const result = await saveRaceEntry(race);
      manualStatus.textContent = result.status;
      renderRecordAlerts(manualRecordAlerts, result);
      manualForm.reset();
      await renderRecentEntries();
      await refreshCurrentRows();
    } catch (error) {
      manualStatus.textContent = error.message || "Could not save this time.";
    }
  });

  form.addEventListener("input", renderSplits);

  renderSplits();
  setButtons();
  await renderRecentEntries();
}

async function renderRecentEntries() {
  const recentList = document.querySelector("#recent-list");
  if (!recentList) {
    return;
  }

  const recentRaces = (hasSupabase ? await getAllRaces() : readLocalRaces()).slice(0, 4);

  if (!recentRaces.length) {
    recentList.innerHTML = "";
    return;
  }

  recentList.innerHTML = recentRaces
    .map((race) => {
      const deleteButton = canDeleteRace(race)
        ? `<button class="delete-log-button" type="button" data-delete-log="${escapeAttribute(race.id)}" aria-label="Delete log for ${escapeAttribute(race.name)}">Delete</button>`
        : "";
      return `
        <div class="recent-row">
          <div>
            <strong>${escapeHtml(race.name)}</strong>
            <span>${escapeHtml(race.bike)} / ${formatDate(race.date)} / ${race.splits.map(formatLap).join(" / ")}</span>
          </div>
          <div class="recent-row-actions">
            <span class="time-cell">${formatEntryTime(race)}</span>
            ${deleteButton}
          </div>
        </div>
      `;
    })
    .join("");

  recentList.querySelectorAll("[data-delete-log]").forEach((button) => {
    button.addEventListener("click", async () => {
      const race = recentRaces.find(
        (entry) => String(entry.id) === String(button.dataset.deleteLog),
      );

      if (!race) {
        return;
      }

      const statusTarget =
        document.querySelector("#manual-status") || document.querySelector("#form-status");

      button.disabled = true;
      button.textContent = "Deleting";

      try {
        await deleteRaceEntry(race);
        if (statusTarget) {
          statusTarget.textContent = "Log deleted.";
        }
        await renderRecentEntries();
      } catch (error) {
        button.disabled = false;
        button.textContent = "Delete";
        if (statusTarget) {
          statusTarget.textContent = error.message || "Could not delete this log.";
        }
      }
    });
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };
    return entities[character];
  });
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}

window.addEventListener("hashchange", renderRoute);
renderRoute();
