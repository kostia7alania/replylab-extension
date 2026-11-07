const DAY = 86400000;
const KINDS = { like: 'like', 'like-observed': 'like', pass: 'pass', dislike: 'pass', 'pass-observed': 'pass' };
const BAND_LABELS = ['18–24', '25–34', '35–44', '45–54', '55+'];
function ageBand(age) {
  if (!Number.isFinite(age) || age < 18 || age > 120) return -1;
  return age < 25 ? 0 : age < 35 ? 1 : age < 45 ? 2 : age < 55 ? 3 : 4;
}
function dayNumber(day) { return Date.parse(day + 'T00:00:00Z') / DAY; }
export function aggregate90days(events, timeZone = 'UTC', now = Date.now()) {
  if (!Array.isArray(events) || !Number.isFinite(now)) throw new TypeError('Нужны массив событий и корректное время.');
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
  const parts = at => Object.fromEntries(formatter.formatToParts(at).map(part => [part.type, part.value]));
  const dayKey = value => value.year + '-' + value.month + '-' + value.day;
  const today = dayKey(parts(now));
  const todayNumber = dayNumber(today);
  const days = Object.fromEntries(Array.from({ length: 90 }, (_, index) => [new Date((todayNumber - 89 + index) * DAY).toISOString().slice(0, 10), 0]));
  const result = { windowDays: 90, timeZone, totalEvents: 0, swipes: 0, likes: 0, passes: 0, likeRate: null,
    activeDays: 0, longestStreak: 0, currentStreak: 0, days, hours: Array(24).fill(0), weekdays: Array(7).fill(0),
    last30: 0, previous30: 0, trendPercent: null,
    taste: { observedLikes: 0, knownAge: 0, unknownAge: 0, knownCity: 0, unknownCity: 0,
      ageBands: BAND_LABELS.map(label => ({ label, likes: 0, passes: 0 })), cities: [] } };
  const cities = new Map();
  for (const event of events) {
    if (!event || event.deleted) continue;
    const at = Date.parse(event.at ?? event.createdAt ?? '');
    if (!Number.isFinite(at) || at > now) continue;
    const local = parts(at), day = dayKey(local);
    if (!Object.hasOwn(days, day)) continue;
    result.totalEvents++;
    const kind = KINDS[event.kind ?? event.type];
    if (!kind) continue;
    result.swipes++; result[kind === 'like' ? 'likes' : 'passes']++;
    days[day]++; result.hours[Number(local.hour)]++;
    result.weekdays[new Date(day + 'T12:00:00Z').getUTCDay()]++;
    const ageInDays = todayNumber - dayNumber(day);
    if (ageInDays < 30) result.last30++; else if (ageInDays < 60) result.previous30++;
    const profile = event.profile ?? {};
    const band = ageBand(profile.age);
    const city = typeof profile.city === 'string' ? profile.city.trim().slice(0, 150) : '';
    if (kind === 'like') {
      result.taste.observedLikes++;
      result.taste[band < 0 ? 'unknownAge' : 'knownAge']++;
      result.taste[city ? 'knownCity' : 'unknownCity']++;
    }
    if (band >= 0) result.taste.ageBands[band][kind === 'like' ? 'likes' : 'passes']++;
    if (city) {
      const key = city.toLocaleLowerCase();
      const group = cities.get(key) ?? { name: city, likes: 0, passes: 0 };
      group[kind === 'like' ? 'likes' : 'passes']++; cities.set(key, group);
    }
  }
  result.likeRate = result.swipes ? result.likes / result.swipes : null;
  result.activeDays = Object.values(days).filter(Boolean).length;
  let streak = 0;
  for (const count of Object.values(days)) { streak = count ? streak + 1 : 0; result.longestStreak = Math.max(result.longestStreak, streak); }
  const entries = Object.entries(days);
  let index = entries.length - 1;
  if (!entries[index][1]) index--;
  for (; index >= 0 && entries[index][1]; index--) result.currentStreak++;
  result.trendPercent = result.previous30 ? (result.last30 - result.previous30) / result.previous30 * 100 : null;
  result.taste.cities = [...cities.values()].sort((a, b) => b.likes + b.passes - a.likes - a.passes);
  return result;
}
