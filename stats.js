const languageNames = { fa:"فارسی", en:"انگلیسی", ar:"عربی", tr:"ترکی", de:"آلمانی", fr:"فرانسوی", es:"اسپانیایی", ru:"روسی", ja:"ژاپنی", ko:"کره‌ای", zh:"چینی" };
const fa = new Intl.NumberFormat("fa-IR");
let sessions = [];

document.addEventListener("DOMContentLoaded", initialize);

async function initialize() {
  const stored = await chrome.storage.local.get(["papaSessions", "navaSessions"]);
  sessions = Array.isArray(stored.papaSessions) ? stored.papaSessions : (Array.isArray(stored.navaSessions) ? stored.navaSessions : []);
  render();
  document.querySelector("#clearData").addEventListener("click", clearData);
  document.querySelector("#exportData").addEventListener("click", exportData);
}

function render() {
  const total = sessions.reduce((sum, item) => sum + Number(item.durationSeconds || 0), 0);
  const byLanguage = groupDuration("targetLanguage");
  const topLanguage = Object.entries(byLanguage).sort((a,b) => b[1] - a[1])[0]?.[0];
  document.querySelector("#totalTime").textContent = formatDuration(total);
  document.querySelector("#sessionCount").textContent = fa.format(sessions.length);
  document.querySelector("#topLanguage").textContent = languageNames[topLanguage] || "—";
  document.querySelector("#averageTime").textContent = formatDuration(sessions.length ? total / sessions.length : 0);
  renderHeatmap();
  renderLanguages(byLanguage);
  renderHistory();
}

function renderHeatmap() {
  const container = document.querySelector("#heatmap");
  const days = [];
  const daily = {};
  for (const item of sessions) {
    const key = localDay(item.startedAt);
    daily[key] = (daily[key] || 0) + Number(item.durationSeconds || 0);
  }
  for (let offset = 83; offset >= 0; offset -= 1) {
    const date = new Date(); date.setHours(0,0,0,0); date.setDate(date.getDate() - offset);
    days.push({ key: localDay(date.getTime()), seconds: daily[localDay(date.getTime())] || 0 });
  }
  const max = Math.max(1, ...days.map(day => day.seconds));
  container.replaceChildren(...days.map(day => {
    const cell = document.createElement("i");
    cell.dataset.level = day.seconds ? Math.max(1, Math.ceil((day.seconds / max) * 4)) : 0;
    cell.title = `${day.key}: ${formatDuration(day.seconds)}`;
    return cell;
  }));
  const activeDays = days.filter(day => day.seconds > 0).length;
  document.querySelector("#activitySummary").textContent = activeDays
    ? `در ${fa.format(activeDays)} روز از ۸۴ روز اخیر از PAPA Dub استفاده کرده‌اید.`
    : "هنوز فعالیتی ثبت نشده است. اولین دوبله شما اینجا نمایش داده می‌شود.";
}

function renderLanguages(byLanguage) {
  const container = document.querySelector("#languageBars");
  const entries = Object.entries(byLanguage).sort((a,b) => b[1] - a[1]);
  if (!entries.length) {
    container.innerHTML = '<div class="empty">هنوز زبانی ثبت نشده است.</div>';
    return;
  }
  const max = entries[0][1];
  container.replaceChildren(...entries.slice(0, 6).map(([code, seconds]) => {
    const row = document.createElement("div"); row.className = "bar-row";
    row.innerHTML = `<div class="bar-label"><strong>${languageNames[code] || code}</strong><span>${formatDuration(seconds)}</span></div><div class="bar-track"><div class="bar-fill" style="width:${Math.max(4,(seconds/max)*100)}%"></div></div>`;
    return row;
  }));
}

function renderHistory() {
  const container = document.querySelector("#historyList");
  const recent = [...sessions].sort((a,b) => b.startedAt - a.startedAt).slice(0, 12);
  document.querySelector("#historyCount").textContent = `${fa.format(sessions.length)} نشست`;
  if (!recent.length) {
    container.innerHTML = '<div class="empty">تاریخچه‌ای وجود ندارد.</div>';
    return;
  }
  container.replaceChildren(...recent.map(item => {
    const date = new Date(item.startedAt);
    const row = document.createElement("div"); row.className = "history-row";
    const srtBtn = item.srt ? `<button class="srt-btn" type="button">دانلود SRT</button>` : `<span class="domain">${escapeHtml(item.domain || "ذخیره نشده")}</span>`;
    row.innerHTML = `<span>${date.toLocaleDateString("fa-IR", {month:"short",day:"numeric"})}</span><strong>${languageNames[item.targetLanguage] || item.targetLanguage}</strong>${srtBtn}<span class="duration">${formatDuration(item.durationSeconds)}</span>`;
    const btn = row.querySelector(".srt-btn");
    if (btn && item.srt) {
      btn.addEventListener("click", () => {
        const blob = new Blob([item.srt], { type: "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `papa-dub-${localDay(item.startedAt)}.srt`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      });
    }
    return row;
  }));
}

async function clearData() {
  if (!confirm("تمام تاریخچه محلی دوبله PAPA Dub پاک شود؟")) return;
  sessions = [];
  await chrome.storage.local.remove(["papaSessions", "navaSessions"]);
  render();
}

function exportData() {
  const blob = new Blob([JSON.stringify({ app: "PAPA Dub", exportedAt: new Date().toISOString(), sessions }, null, 2)], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a"); link.href = url; link.download = "papa-dub-history.json"; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function groupDuration(key) {
  return sessions.reduce((result, item) => {
    const value = item[key] || "unknown";
    result[value] = (result[value] || 0) + Number(item.durationSeconds || 0);
    return result;
  }, {});
}

function formatDuration(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  if (value < 60) return `${fa.format(value)} ثانیه`;
  if (value < 3600) return `${fa.format(Math.round(value / 60))} دقیقه`;
  return `${fa.format((value / 3600).toFixed(1))} ساعت`;
}

function localDay(timestamp) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
}

function escapeHtml(text) {
  const node = document.createElement("span"); node.textContent = text; return node.innerHTML;
}
