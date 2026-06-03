const STORAGE_KEY = "dunscreek.localRaces";

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
    return Array.isArray(parsed) ? parsed.filter(isRace) : [];
  } catch {
    return [];
  }
}

function writeLocalRaces(races) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(races));
}

function normalizeRace(row) {
  return {
    bike: String(row.bike || "").trim(),
    date: String(row.race_date || row.date || "").slice(0, 10),
    name: String(row.name || "").trim(),
    splits: [row.lap1, row.lap2, row.lap3].map(Number),
  };
}

async function readRemoteRaces() {
  if (!hasSupabase) {
    return [];
  }

  const response = await fetch(
    getSupabaseEndpoint("?select=name,bike,race_date,lap1,lap2,lap3&order=created_at.desc"),
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
  const response = await fetch(getSupabaseEndpoint(), {
    body: JSON.stringify({
      bike: race.bike,
      lap1: race.splits[0],
      lap2: race.splits[1],
      lap3: race.splits[2],
      name: race.name,
      race_date: race.date || getTodayDate(),
    }),
    headers: {
      apikey: supabaseConfig.anonKey,
      Authorization: `Bearer ${supabaseConfig.anonKey}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(`Could not save time: ${response.status}`);
  }
}

function isRace(race) {
  return (
    race &&
    typeof race.name === "string" &&
    typeof race.bike === "string" &&
    Array.isArray(race.splits) &&
    race.splits.length === 3 &&
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
    const total = race.splits.reduce((sum, split) => sum + split, 0);
    const lap = Math.min(...race.splits);
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

    if (total < existing.bestRaceTotal) {
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

function formatRace(value) {
  const minutes = Math.floor(value / 60);
  const seconds = value - minutes * 60;
  return `${minutes}:${seconds.toFixed(3).padStart(6, "0")}`;
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

function getTodayDate() {
  return new Date().toISOString().slice(0, 10);
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
  const total = race.splits.reduce((sum, split) => sum + split, 0);
  const bestLap = Math.min(...race.splits);

  if (!previous) {
    return `First run saved for ${race.name}: ${formatRace(total)}.`;
  }

  const beatRace = total < previous.bestRaceTotal;
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

  return `Run saved: ${formatRace(total)}. Best remains ${formatRace(previous.bestRaceTotal)}.`;
}

async function getSaveResult(race) {
  const previousRaces = await getAllRaces();
  const previousPersonal = findPersonalBest(race.name, race.bike, previousRaces);
  const previousRows = aggregateRaces(previousRaces);
  const previousBikeRows = previousRows.filter(
    (row) => row.bike.trim().toLowerCase() === race.bike.trim().toLowerCase(),
  );
  const total = race.splits.reduce((sum, split) => sum + split, 0);
  const bestLap = Math.min(...race.splits);
  const previousTrackLap = previousRows[0]?.bestLap ?? Number.POSITIVE_INFINITY;
  const previousTrackRace = previousRows.reduce(
    (best, row) => Math.min(best, row.bestRaceTotal),
    Number.POSITIVE_INFINITY,
  );
  const previousBikeLap = previousBikeRows.reduce(
    (best, row) => Math.min(best, row.bestLap),
    Number.POSITIVE_INFINITY,
  );
  const previousBikeRace = previousBikeRows.reduce(
    (best, row) => Math.min(best, row.bestRaceTotal),
    Number.POSITIVE_INFINITY,
  );
  const alerts = [];

  if (previousPersonal) {
    const beatRace = total < previousPersonal.bestRaceTotal;
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
      detail: `${formatLap(bestLap)} lap / ${formatRace(total)} race`,
      title: "First track records set",
      type: "track",
    });
  } else {
    const beatTrackLap = bestLap < previousTrackLap;
    const beatTrackRace = total < previousTrackRace;

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
      detail: `${race.bike} / ${formatLap(bestLap)} lap / ${formatRace(total)} race`,
      title: "First bike records set",
      type: "bike",
    });
  } else {
    const beatBikeLap = bestLap < previousBikeLap;
    const beatBikeRace = total < previousBikeRace;

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
    localRaces.unshift(race);
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
  const fastest = rows[0];

  view.innerHTML = `
    <section class="hero-board" aria-labelledby="all-time-heading">
      <div class="board-panel">
        <div class="board-header">
          <div>
            <p class="eyebrow">All time</p>
            <h1 id="all-time-heading">Leaderboard</h1>
          </div>
          <div class="board-meta" aria-label="Leaderboard stats">
            <div class="metric">
              <strong>${rows.length}</strong>
              <span>Riders</span>
            </div>
            <div class="metric">
              <strong>${fastest ? formatLap(fastest.bestLap) : "-"}</strong>
              <span>Best lap</span>
            </div>
          </div>
        </div>
        <div class="table-wrap">
          <table class="leaderboard-table all-time-table">
            <thead>
              <tr>
                <th scope="col">Rank</th>
                <th scope="col">Name</th>
                <th scope="col">Lap time</th>
                <th scope="col">Bike</th>
                <th scope="col">Date</th>
              </tr>
            </thead>
            <tbody>
              ${
                rows.length
                  ? rows.map(renderAllTimeRow).join("")
                  : `<tr><td colspan="5" class="empty-state">No times logged yet.</td></tr>`
              }
            </tbody>
          </table>
        </div>
      </div>
    </section>
  `;
}

function renderAllTimeRow(row, index) {
  return `
    <tr>
      <td class="rank" data-label="Rank">${index + 1}</td>
      <td class="name-cell" data-label="Name">${escapeHtml(row.name)}</td>
      <td class="time-cell" data-label="Lap">${formatLap(row.bestLap)}</td>
      <td data-label="Bike"><span class="bike-pill">${escapeHtml(row.bike)}</span></td>
      <td class="date-cell" data-label="Date">${formatDate(row.bestLapDate)}</td>
    </tr>
  `;
}

async function renderLeaderboardPage() {
  const rows = aggregateRaces(await getAllRaces()).sort(
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
    </section>
  `;

  const userFilter = document.querySelector("#user-filter");
  const bikeFilter = document.querySelector("#bike-filter");
  const dateFilter = document.querySelector("#date-filter");
  const renderRows = () => {
    const userQuery = userFilter.value.trim().toLowerCase();
    const bike = bikeFilter.value;
    const date = dateFilter.value;
    const filteredRows = rows.filter((row) => {
      const matchesUser = row.name.toLowerCase().includes(userQuery);
      const matchesBike = !bike || row.bike === bike;
      const matchesDate = !date || row.bestRaceDate === date || row.bestLapDate === date;
      return matchesUser && matchesBike && matchesDate;
    });

    document.querySelector("#detail-rows").innerHTML = filteredRows.length
      ? filteredRows.map(renderDetailedRow).join("")
      : `<tr><td colspan="7" class="empty-state">No times match those filters.</td></tr>`;
  };

  userFilter.addEventListener("input", renderRows);
  bikeFilter.addEventListener("change", renderRows);
  dateFilter.addEventListener("change", renderRows);
  renderRows();
}

function renderDetailedRow(row, index) {
  return `
    <tr>
      <td class="rank" data-label="Rank">${index + 1}</td>
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

async function renderLogPage() {
  const today = getTodayDate();
  const currentRows = aggregateRaces(await getAllRaces());

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
              <input name="lap2" inputmode="decimal" placeholder="Lap 2" required>
              <input name="lap3" inputmode="decimal" placeholder="Lap 3" required>
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

  const setButtons = () => {
    const complete = timer.splits.length >= 3;
    startButton.disabled = timer.running || complete;
    stopButton.disabled = !timer.running;
    lapButton.disabled = !timer.running || complete;
    resetButton.disabled = false;
  };

  const renderSplits = () => {
    splitBoard.innerHTML = [0, 1, 2]
      .map((index) => {
        const split = timer.splits[index];
        const isFilled = Number.isFinite(split);
        return `
          <div class="split-card ${isFilled ? "is-filled" : ""}">
            <span>Lap ${index + 1}</span>
            <strong>${isFilled ? formatLap(split) : "--"}</strong>
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
      status.textContent = "Complete three laps before saving.";
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
      setButtons();
    } catch (error) {
      timer.saved = false;
      status.textContent = error.message || "Could not save this time.";
      setButtons();
    }
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

    status.textContent = `${3 - timer.splits.length} lap${timer.splits.length === 2 ? "" : "s"} left.`;
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

  resetButton.addEventListener("click", resetTimer);

  manualForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const data = new FormData(manualForm);
    const race = {
      name: String(data.get("name")).trim(),
      bike: String(data.get("bike")).trim(),
      splits: ["lap1", "lap2", "lap3"].map((key) =>
        parseTime(String(data.get(key))),
      ),
      date: String(data.get("date") || getTodayDate()),
    };

    if (!isRace(race)) {
      manualStatus.textContent = "Check the rider, bike, and three lap times.";
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
    } catch (error) {
      manualStatus.textContent = error.message || "Could not save this time.";
    }
  });

  renderSplits();
  setButtons();
  await renderRecentEntries();
}

async function renderRecentEntries() {
  const recentList = document.querySelector("#recent-list");
  const recentRaces = (hasSupabase ? await getAllRaces() : readLocalRaces()).slice(0, 4);

  if (!recentRaces.length) {
    recentList.innerHTML = "";
    return;
  }

  recentList.innerHTML = recentRaces
    .map((race) => {
      const total = race.splits.reduce((sum, split) => sum + split, 0);
      return `
        <div class="recent-row">
          <div>
            <strong>${escapeHtml(race.name)}</strong>
            <span>${escapeHtml(race.bike)} / ${formatDate(race.date)} / ${race.splits.map(formatLap).join(" / ")}</span>
          </div>
          <span class="time-cell">${formatRace(total)}</span>
        </div>
      `;
    })
    .join("");
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
