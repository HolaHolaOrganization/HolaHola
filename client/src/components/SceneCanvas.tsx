/**
 * SceneCanvas — Interactive live-compositing canvas for Daniela lessons.
 *
 * Phase 1 (Spatial):
 *   - Background: CSS object-cover image in a 16:9 container
 *   - Props: absolutely-positioned transparent PNGs at cx/cy percentages
 *   - Clock: SVG analog clock rendered client-side from a "H:MM" string
 *
 * Phase 2 (Grammar canvas — full-panel, replaces spatial view when active):
 *   - ConjugationTableCanvas: progressive fill-in verb conjugation table
 *   - CalendarCanvas: month grid with day/date highlighting
 */

import { motion, AnimatePresence } from "framer-motion";
import type {
  SceneCanvasItemData,
  SceneCanvasProp,
  ConjugationTableData,
  CalendarData,
  BodyDiagramData,
  FaceDiagramData,
  HandDiagramData,
  ThermometerData,
  EmotionData,
  WeatherData,
  WorldMapData,
} from "@shared/whiteboard-types";

// ─── Analog Clock SVG ─────────────────────────────────────────────────────────

export function AnalogClock({ time }: { time: string }) {
  const parts = time.split(":");
  const hourRaw = parseInt(parts[0] ?? "12", 10);
  const minute = parseInt(parts[1] ?? "0", 10);
  const hour = hourRaw % 12;

  const hourAngle = (hour + minute / 60) * 30;
  const minuteAngle = minute * 6;

  const hourMarkers = Array.from({ length: 12 }, (_, i) => {
    const a = (i * 30 * Math.PI) / 180;
    const isMajor = i % 3 === 0;
    const inner = isMajor ? 39 : 42;
    return {
      x1: 50 + inner * Math.sin(a),
      y1: 50 - inner * Math.cos(a),
      x2: 50 + 46 * Math.sin(a),
      y2: 50 - 46 * Math.cos(a),
      w: isMajor ? 2 : 1,
    };
  });

  const hourNumbers = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n, i) => {
    const a = (i * 30 * Math.PI) / 180;
    return { n, x: 50 + 33 * Math.sin(a), y: 50 - 33 * Math.cos(a) + 3.5 };
  });

  const handEnd = (angle: number, length: number) => ({
    x: 50 + length * Math.sin((angle * Math.PI) / 180),
    y: 50 - length * Math.cos((angle * Math.PI) / 180),
  });

  const hourTip = handEnd(hourAngle, 25);
  const minuteTip = handEnd(minuteAngle, 37);

  return (
    <svg viewBox="0 0 100 100" className="w-full h-full" aria-label={`Clock showing ${time}`}>
      <circle cx="50" cy="50" r="48" fill="white" stroke="#d1d5db" strokeWidth="1.5" />
      {hourMarkers.map((m, i) => (
        <line key={i} x1={m.x1} y1={m.y1} x2={m.x2} y2={m.y2} stroke="#6b7280" strokeWidth={m.w} strokeLinecap="round" />
      ))}
      {hourNumbers.map(({ n, x, y }) => (
        <text key={n} x={x} y={y} textAnchor="middle" fontSize="8" fill="#374151" fontFamily="system-ui, sans-serif" fontWeight="500">
          {n}
        </text>
      ))}
      <line x1="50" y1="50" x2={hourTip.x} y2={hourTip.y} stroke="#111827" strokeWidth="4" strokeLinecap="round" />
      <line x1="50" y1="50" x2={minuteTip.x} y2={minuteTip.y} stroke="#374151" strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="50" cy="50" r="2.5" fill="#111827" />
    </svg>
  );
}

// ─── 12-hour time label helper ────────────────────────────────────────────────

function formatTime12h(time: string): string {
  const parts = time.split(":");
  const h = parseInt(parts[0] ?? "12", 10);
  const m = parseInt(parts[1] ?? "0", 10);
  const period = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m.toString().padStart(2, "0")} ${period}`;
}

// ─── Prop layer ────────────────────────────────────────────────────────────────

function PropLayer({ prop }: { prop: SceneCanvasProp }) {
  const rotate = prop.rotate ?? 0;
  const flipH = prop.flipH ? "scaleX(-1)" : "";
  const transform = `translate(-50%, -50%) rotate(${rotate}deg) ${flipH}`.trim();
  const zIndex = prop.z ?? 5;

  return (
    <motion.div
      key={prop.name}
      initial={{ opacity: 0, scale: 0.65 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.65 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      className="absolute"
      style={{
        left: `${prop.cx * 100}%`,
        top: `${prop.cy * 100}%`,
        width: `${prop.scale * 100}%`,
        transform,
        zIndex,
        pointerEvents: "none",
      }}
    >
      <img
        src={prop.imageUrl}
        alt={prop.label}
        className="w-full h-auto"
        style={{
          filter: prop.state === 'success'
            ? "drop-shadow(0 0 10px rgba(255,210,60,0.85)) drop-shadow(0 2px 6px rgba(0,0,0,0.30))"
            : prop.state === 'cold'
              ? "drop-shadow(0 2px 6px rgba(0,0,0,0.30)) grayscale(0.65) brightness(0.78)"
              : "drop-shadow(0 2px 6px rgba(0,0,0,0.30))",
          transition: prop.state === 'success'
            ? "filter 1.2s cubic-bezier(0.4, 0, 0.2, 1)"
            : "filter 0.6s ease",
        }}
        draggable={false}
      />
      <div className="absolute left-1/2 -translate-x-1/2" style={{ top: "calc(100% + 3px)" }}>
        <span className="flex flex-col items-center text-white rounded bg-black/65 px-1.5 py-0.5 whitespace-nowrap">
          <span className="text-[10px] leading-tight font-semibold">{prop.label}</span>
          {prop.nativeLabel && (
            <span className="text-[8px] leading-tight text-white/70">{prop.nativeLabel}</span>
          )}
        </span>
      </div>
    </motion.div>
  );
}

// ─── Clock-only canvas (no background) ────────────────────────────────────────

function ClockOnlyCanvas({ time, label, showLabel, compact }: { time: string; label?: string; showLabel?: boolean; compact?: boolean }) {
  const displayLabel = showLabel !== false && label;

  if (compact) return (
    <motion.div
      initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.4, ease: "easeOut" }}
      className="flex flex-col items-center gap-1 p-3 bg-card rounded-xl border border-border min-w-[80px]"
    >
      <div className="w-12 h-12 bg-white rounded-full shadow-sm border border-border p-0.5">
        <AnalogClock time={time} />
      </div>
      <span className="text-[11px] font-mono text-muted-foreground">{formatTime12h(time)}</span>
      {displayLabel && (
        <span className="text-[10px] font-semibold text-center leading-tight max-w-[80px]">{label}</span>
      )}
    </motion.div>
  );

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.4, ease: "easeOut" }}
      className="flex flex-col items-center gap-3 p-6"
    >
      <div className="w-48 h-48 bg-white rounded-full shadow-md border border-border p-2">
        <AnalogClock time={time} />
      </div>
      <span className="text-sm font-mono text-muted-foreground">{formatTime12h(time)}</span>
      {displayLabel && (
        <span className="text-lg font-semibold text-foreground text-center">{label}</span>
      )}
    </motion.div>
  );
}

// ─── Conjugation Table Canvas ─────────────────────────────────────────────────

function ConjugationTableCanvas({ table }: { table: ConjugationTableData }) {
  return (
    <motion.div
      key={`${table.verb}-${table.tense}`}
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: "easeOut" }}
      className="w-full h-full flex flex-col items-center justify-center p-4 sm:p-6 bg-background"
      data-testid="canvas-conjugation"
    >
      {/* Header */}
      <div className="mb-5 text-center">
        <div className="text-2xl sm:text-3xl font-bold tracking-tight text-foreground">
          {table.verb}
        </div>
        <div className="text-sm text-muted-foreground mt-1 font-medium">
          {table.tense}
        </div>
      </div>

      {/* Table */}
      <div className="w-full max-w-xs sm:max-w-sm">
        <div className="rounded-lg border border-border overflow-hidden">
          {table.cells.map((cell, i) => {
            const isHighlighted = table.highlightPronoun === cell.pronoun;
            const isNew = cell.isNew;
            const hasForm = cell.form !== null;

            return (
              <motion.div
                key={`${cell.pronoun}-${i}`}
                className={[
                  "flex items-center",
                  i > 0 ? "border-t border-border" : "",
                  isHighlighted ? "bg-primary/8" : "bg-card",
                ].join(" ")}
              >
                {/* Pronoun column */}
                <div
                  className={[
                    "flex-shrink-0 w-28 sm:w-32 px-3 py-2.5 text-sm",
                    isHighlighted ? "font-bold text-primary" : "font-medium text-muted-foreground",
                  ].join(" ")}
                >
                  <span>{cell.pronoun}</span>
                  {cell.pronounAlt && (
                    <span className="block text-[11px] text-muted-foreground/60">{cell.pronounAlt}</span>
                  )}
                </div>

                {/* Divider */}
                <div className="self-stretch w-px bg-border" />

                {/* Form column */}
                <div className="flex-1 px-3 py-2.5">
                  {hasForm ? (
                    <motion.span
                      key={cell.form}
                      initial={isNew ? { opacity: 0, scale: 0.85 } : false}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ duration: 0.3, ease: "easeOut" }}
                      className={[
                        "text-sm font-semibold",
                        isHighlighted ? "text-primary" : "text-foreground",
                        isNew ? "underline decoration-primary/40 decoration-2 underline-offset-2" : "",
                      ].join(" ")}
                    >
                      {cell.form}
                    </motion.span>
                  ) : (
                    <span className="text-sm text-muted-foreground/40 font-mono tracking-widest select-none">
                      ___
                    </span>
                  )}
                </div>
              </motion.div>
            );
          })}
        </div>
      </div>
    </motion.div>
  );
}

// ─── Calendar Canvas ──────────────────────────────────────────────────────────

export function CalendarCanvas({ cal }: { cal: CalendarData }) {
  const startDow = cal.startDow ?? 1; // default Mon-first

  // Compute first day of month's day-of-week (0=Sun)
  const firstDate = new Date(cal.year, cal.monthNumber - 1, 1);
  const firstDow = firstDate.getDay(); // 0=Sun

  // Offset: how many empty cells before day 1
  // startDow=1 (Mon-first): Mon=0, Tue=1, Wed=2, Thu=3, Fri=4, Sat=5, Sun=6
  // startDow=0 (Sun-first): Sun=0, Mon=1, ...
  const offset = ((firstDow - startDow) + 7) % 7;

  const daysInMonth = new Date(cal.year, cal.monthNumber, 0).getDate();

  // Build 6-row × 7-col grid
  const cells: (number | null)[] = [];
  for (let i = 0; i < offset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const rows: (number | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));

  const highlight = cal.highlightDay;
  const marked = new Set(cal.markedDays ?? []);
  const hlDowIdx = cal.highlightDowIndex;

  const dayNames = cal.dayNames.length === 7
    ? cal.dayNames
    : ["Lu", "Ma", "Mi", "Ju", "Vi", "Sa", "Do"];

  return (
    <motion.div
      key={`${cal.month}-${cal.year}`}
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: "easeOut" }}
      className="w-full h-full flex flex-col items-center justify-center p-4 sm:p-6 bg-background"
      data-testid="canvas-calendar"
    >
      {/* Month / Year header */}
      <div className="mb-4 text-center">
        <div className="text-2xl sm:text-3xl font-bold tracking-tight text-foreground capitalize">
          {cal.month}
        </div>
        <div className="text-sm text-muted-foreground mt-0.5">{cal.year}</div>
      </div>

      {/* Calendar grid */}
      <div className="w-full max-w-xs sm:max-w-sm">
        {/* Day-name header row */}
        <div className="grid grid-cols-7 mb-1">
          {dayNames.map((name, colIdx) => (
            <div
              key={colIdx}
              className={[
                "text-center text-[11px] font-semibold py-1 rounded",
                hlDowIdx === colIdx
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground",
              ].join(" ")}
            >
              {name}
            </div>
          ))}
        </div>

        {/* Date rows */}
        <div className="grid grid-cols-7 gap-0.5">
          {rows.map((row, rIdx) =>
            row.map((day, colIdx) => {
              const isHighlight = day !== null && day === highlight;
              const isMarked = day !== null && marked.has(day);
              const isDowHighlight = hlDowIdx === colIdx && day !== null;

              return (
                <motion.div
                  key={`${rIdx}-${colIdx}`}
                  initial={isHighlight ? { scale: 0.7, opacity: 0 } : false}
                  animate={isHighlight ? { scale: 1, opacity: 1 } : {}}
                  transition={{ duration: 0.3, delay: 0.15, ease: "easeOut" }}
                  className={[
                    "aspect-square flex items-center justify-center rounded text-sm font-medium select-none",
                    day === null ? "" : "cursor-default",
                    isHighlight
                      ? "bg-primary text-primary-foreground font-bold shadow-sm"
                      : isMarked
                        ? "bg-primary/15 text-primary"
                        : isDowHighlight
                          ? "bg-primary/8 text-foreground"
                          : day !== null
                            ? "text-foreground hover-elevate"
                            : "",
                  ].join(" ")}
                >
                  {day}
                </motion.div>
              );
            })
          )}
        </div>
      </div>
    </motion.div>
  );
}

// ─── Thermometer Canvas ───────────────────────────────────────────────────────

export function ThermometerCanvas({ data, compact }: { data: ThermometerData; compact?: boolean }) {
  const { celsius, labelText } = data;
  // Auto-detect US users from browser locale and default Fahrenheit on (unless explicitly set to false)
  const isUS = typeof navigator !== 'undefined' && (navigator.language === 'en-US' || navigator.language?.endsWith('-US'));
  const showFahrenheit = data.showFahrenheit !== false && (data.showFahrenheit === true || isUS);
  const minTemp = -30, maxTemp = 60;
  const pct = Math.min(1, Math.max(0, (celsius - minTemp) / (maxTemp - minTemp)));
  const fahrenheit = Math.round(celsius * 9 / 5 + 32);
  const tubeTop = 32, tubeBottom = 260, tubeHeight = tubeBottom - tubeTop;
  const fillHeight = pct * tubeHeight;
  const fillY = tubeBottom - fillHeight;
  const fillColor = celsius <= 0 ? '#3b82f6' : celsius <= 15 ? '#22c55e' : celsius <= 30 ? '#f97316' : '#ef4444';
  const ticks = [-20, -10, 0, 10, 20, 30, 40, 50].filter(t => t >= minTemp && t <= maxTemp);

  // ── Compact ribbon card ───────────────────────────────────────────────────
  if (compact) {
    const cTubeH = 44; // compact tube height in SVG units
    const cFillH = pct * cTubeH;
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}
        className="flex flex-col items-center gap-1 p-3 bg-card rounded-xl border border-border min-w-[80px]"
      >
        <svg viewBox="0 0 30 78" className="w-6 h-14" aria-hidden>
          {/* Tube bg */}
          <rect x="10" y="4" width="10" height={cTubeH} rx="5" fill="hsl(var(--muted))" stroke="hsl(var(--border))" strokeWidth="1.5" />
          {/* Mercury fill */}
          <rect x="12" y={4 + cTubeH - cFillH} width="6" height={cFillH} rx="3" fill={fillColor} />
          {/* Tube border overlay */}
          <rect x="10" y="4" width="10" height={cTubeH} rx="5" fill="none" stroke="hsl(var(--border))" strokeWidth="1.5" />
          {/* Bulb */}
          <circle cx="15" cy="63" r="12" fill={fillColor} />
          <circle cx="15" cy="63" r="12" fill="none" stroke="hsl(var(--border))" strokeWidth="1.5" />
        </svg>
        <p className="text-base font-bold tabular-nums leading-none">
          {showFahrenheit ? `${fahrenheit}°F` : `${celsius}°C`}
        </p>
        {showFahrenheit && <p className="text-[10px] text-muted-foreground leading-none">{celsius}°C</p>}
        {labelText && <p className="text-[10px] text-muted-foreground text-center leading-tight max-w-[72px] truncate">{labelText}</p>}
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      className="flex flex-col items-center gap-3 p-6"
    >
      <svg viewBox="0 0 130 330" className="w-20 sm:w-28" aria-label={`Thermometer: ${showFahrenheit ? `${fahrenheit}°F` : `${celsius}°C`}`}>
        {/* Tick marks */}
        {ticks.map(t => {
          const y = tubeBottom - ((t - minTemp) / (maxTemp - minTemp)) * tubeHeight;
          const isMajor = t % 20 === 0;
          return (
            <g key={t}>
              <line x1="66" y1={y} x2={isMajor ? 80 : 76} y2={y} stroke="currentColor" strokeWidth={isMajor ? 1.5 : 1} className="text-muted-foreground" />
              {isMajor && (
                <text x="85" y={y + 4} fontSize="10" fill="currentColor" className="text-muted-foreground" fontFamily="system-ui,sans-serif">{t}°</text>
              )}
            </g>
          );
        })}
        {/* Zero line */}
        {(() => { const y = tubeBottom - ((0 - minTemp) / (maxTemp - minTemp)) * tubeHeight; return <line key="zero" x1="56" y1={y} x2="82" y2={y} stroke="#6b7280" strokeWidth="1.5" strokeDasharray="3,2" />; })()}
        {/* Tube background */}
        <rect x="52" y={tubeTop} width="20" height={tubeHeight} rx="10" fill="hsl(var(--muted))" stroke="hsl(var(--border))" strokeWidth="1.5" />
        {/* Mercury fill */}
        <motion.rect
          x="55" rx="8"
          y={fillY} width="14" height={fillHeight}
          fill={fillColor}
          initial={{ height: 0, y: tubeBottom }}
          animate={{ height: fillHeight, y: fillY }}
          transition={{ duration: 1.4, ease: 'easeOut' }}
        />
        {/* Tube overlay (border on top) */}
        <rect x="52" y={tubeTop} width="20" height={tubeHeight} rx="10" fill="none" stroke="hsl(var(--border))" strokeWidth="1.5" />
        {/* Bulb — show primary unit's value */}
        <circle cx="62" cy={tubeBottom + 16} r="20" fill={fillColor} />
        <circle cx="62" cy={tubeBottom + 16} r="20" fill="none" stroke="hsl(var(--border))" strokeWidth="1.5" />
        <text x="62" y={tubeBottom + 21} textAnchor="middle" fontSize="11" fill="white" fontWeight="700" fontFamily="system-ui,sans-serif">
          {showFahrenheit ? `${fahrenheit}°` : `${celsius}°`}
        </text>
      </svg>
      <div className="text-center">
        {showFahrenheit ? (
          <>
            <p className="text-3xl font-bold tabular-nums">{fahrenheit}°F</p>
            <p className="text-sm text-muted-foreground">{celsius}°C</p>
          </>
        ) : (
          <p className="text-3xl font-bold tabular-nums">{celsius}°C</p>
        )}
        {labelText && <p className="text-sm text-muted-foreground mt-1 italic">{labelText}</p>}
      </div>
    </motion.div>
  );
}

// ─── Emotion Face Canvas ──────────────────────────────────────────────────────

export const EMOTION_CONFIG: Record<string, {
  faceColor: string;
  mouth: string;
  eyeClose: boolean;
  eyeWide: boolean;
  browLeft: string;
  browRight: string;
  mouthOpen?: boolean; // A filled, open mouth rather than a line.
}> = {
  happy:    { faceColor: '#facc15', mouth: 'M 40 75 Q 60 92 80 75', eyeClose: false, eyeWide: false, browLeft: 'M 35 48 Q 45 44 55 48', browRight: 'M 65 48 Q 75 44 85 48' },
  excited:  { faceColor: '#fb923c', mouth: 'M 35 70 Q 60 108 85 70 Z', mouthOpen: true, eyeClose: false, eyeWide: true,  browLeft: 'M 33 42 Q 44 34 55 42', browRight: 'M 65 42 Q 76 34 87 42' },
  sad:      { faceColor: '#60a5fa', mouth: 'M 40 82 Q 60 68 80 82', eyeClose: false, eyeWide: false, browLeft: 'M 35 50 Q 45 46 55 52', browRight: 'M 65 52 Q 75 46 85 50' },
  angry:    { faceColor: '#f87171', mouth: 'M 40 82 Q 60 72 80 82', eyeClose: true,  eyeWide: false, browLeft: 'M 35 46 Q 45 52 55 48', browRight: 'M 65 48 Q 75 52 85 46' },
  surprised:{ faceColor: '#c084fc', mouth: 'M 52 72 Q 60 88 68 72', eyeClose: false, eyeWide: true,  browLeft: 'M 33 44 Q 44 38 55 44', browRight: 'M 65 44 Q 76 38 87 44' },
  afraid:   { faceColor: '#86efac', mouth: 'M 42 78 Q 60 90 78 78', eyeClose: false, eyeWide: true,  browLeft: 'M 35 52 Q 45 44 55 50', browRight: 'M 65 50 Q 75 44 85 52' },
  confused: { faceColor: '#67e8f9', mouth: 'M 40 76 Q 52 72 65 79', eyeClose: false, eyeWide: false, browLeft: 'M 35 50 Q 45 46 55 50', browRight: 'M 65 48 Q 75 44 83 50' },
  tired:    { faceColor: '#94a3b8', mouth: 'M 42 76 L 78 76',      eyeClose: true,  eyeWide: false, browLeft: 'M 35 52 Q 45 52 55 52', browRight: 'M 65 52 Q 75 52 85 52' },
  nervous:  { faceColor: '#fda4af', mouth: 'M 40 76 Q 50 70 60 78 Q 70 85 80 76', eyeClose: false, eyeWide: false, browLeft: 'M 35 52 Q 45 46 55 52', browRight: 'M 65 52 Q 75 46 85 52' },
  disgusted:{ faceColor: '#a3e635', mouth: 'M 38 82 Q 60 70 82 82', eyeClose: true, eyeWide: false, browLeft: 'M 35 46 Q 45 52 55 48', browRight: 'M 65 48 Q 75 52 85 46' },
  bored:    { faceColor: '#9ca3af', mouth: 'M 40 76 L 80 76',      eyeClose: true,  eyeWide: false, browLeft: 'M 35 52 Q 45 52 55 52', browRight: 'M 65 52 Q 75 52 85 52' },
};

function EmotionFaceCanvas({ data, compact }: { data: EmotionData; compact?: boolean }) {
  const cfg = EMOTION_CONFIG[data.emotion] ?? EMOTION_CONFIG['happy'];
  const eyeRy = cfg.eyeWide ? 10 : cfg.eyeClose ? 3 : 7;

  const FaceSvg = ({ className }: { className: string }) => (
    <svg viewBox="0 0 120 130" className={className} aria-label={`Emotion: ${data.emotion}`}>
      <circle cx="60" cy="60" r="52" fill={cfg.faceColor} />
      <circle cx="60" cy="60" r="52" fill="none" stroke="rgba(0,0,0,0.12)" strokeWidth="2" />
      <path d={cfg.browLeft}  fill="none" stroke="rgba(0,0,0,0.55)" strokeWidth="3.5" strokeLinecap="round" />
      <path d={cfg.browRight} fill="none" stroke="rgba(0,0,0,0.55)" strokeWidth="3.5" strokeLinecap="round" />
      <ellipse cx="44" cy="58" rx="7" ry={eyeRy} fill="rgba(0,0,0,0.75)" />
      <ellipse cx="76" cy="58" rx="7" ry={eyeRy} fill="rgba(0,0,0,0.75)" />
      {!cfg.eyeClose && !cfg.eyeWide && (<><circle cx="46" cy="55" r="2" fill="white" /><circle cx="78" cy="55" r="2" fill="white" /></>)}
      <path d={cfg.mouth} fill={cfg.mouthOpen ? 'rgba(0,0,0,0.7)' : 'none'} stroke="rgba(0,0,0,0.7)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );

  if (compact) return (
    <motion.div
      key={data.emotion} initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.45, type: 'spring', stiffness: 160, damping: 14 }}
      className="flex flex-col items-center gap-1 p-3 bg-card rounded-xl border border-border min-w-[80px]"
    >
      <FaceSvg className="w-12 h-12" />
      {data.label
        ? <span className="text-[10px] font-medium text-center leading-tight">{data.label}</span>
        : <span className="text-[10px] text-muted-foreground capitalize">{data.emotion}</span>
      }
    </motion.div>
  );

  return (
    <motion.div
      key={data.emotion}
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.45, type: 'spring', stiffness: 160, damping: 14 }}
      className="flex flex-col items-center gap-3 p-6"
    >
      <FaceSvg className="w-32 sm:w-44" />
      {data.label
        ? <span className="text-xl font-semibold tracking-wide">{data.label}</span>
        : <span className="text-base text-muted-foreground capitalize">{data.emotion}</span>
      }
    </motion.div>
  );
}

// ─── Weather Canvas ───────────────────────────────────────────────────────────

export function WeatherIcon({ condition, size = 80 }: { condition: string; size?: number }) {
  const s = size;
  const c = s / 2;
  switch (condition) {
    case 'sunny': case 'hot': return (
      <svg viewBox="0 0 100 100" width={s} height={s} aria-hidden>
        <circle cx="50" cy="50" r="22" fill={condition === 'hot' ? '#ef4444' : '#facc15'} />
        {[0,45,90,135,180,225,270,315].map(a => {
          const r1 = 28, r2 = 42;
          const rad = (a * Math.PI) / 180;
          return <line key={a} x1={50+r1*Math.cos(rad)} y1={50+r1*Math.sin(rad)} x2={50+r2*Math.cos(rad)} y2={50+r2*Math.sin(rad)} stroke={condition === 'hot' ? '#ef4444' : '#facc15'} strokeWidth="4" strokeLinecap="round" />;
        })}
      </svg>
    );
    case 'cold': return (
      <svg viewBox="0 0 100 100" width={s} height={s} aria-hidden>
        <line x1="50" y1="12" x2="50" y2="88" stroke="#60a5fa" strokeWidth="6" strokeLinecap="round" />
        <line x1="12" y1="50" x2="88" y2="50" stroke="#60a5fa" strokeWidth="6" strokeLinecap="round" />
        <line x1="22" y1="22" x2="78" y2="78" stroke="#60a5fa" strokeWidth="6" strokeLinecap="round" />
        <line x1="78" y1="22" x2="22" y2="78" stroke="#60a5fa" strokeWidth="6" strokeLinecap="round" />
        {[[50,12],[50,88],[12,50],[88,50],[22,22],[78,78],[78,22],[22,78]].map(([x,y],i) => (
          <circle key={i} cx={x} cy={y} r="5" fill="#60a5fa" />
        ))}
      </svg>
    );
    case 'cloudy': return (
      <svg viewBox="0 0 100 100" width={s} height={s} aria-hidden>
        <ellipse cx="50" cy="58" rx="32" ry="20" fill="#94a3b8" />
        <circle cx="36" cy="54" r="16" fill="#94a3b8" />
        <circle cx="60" cy="50" r="20" fill="#94a3b8" />
      </svg>
    );
    case 'partly_cloudy': return (
      <svg viewBox="0 0 100 100" width={s} height={s} aria-hidden>
        <circle cx="38" cy="36" r="18" fill="#facc15" />
        {[0,60,120,180,240,300].map(a => { const rad=(a*Math.PI)/180; return <line key={a} x1={38+22*Math.cos(rad)} y1={36+22*Math.sin(rad)} x2={38+30*Math.cos(rad)} y2={36+30*Math.sin(rad)} stroke="#facc15" strokeWidth="3.5" strokeLinecap="round" />; })}
        <ellipse cx="60" cy="66" rx="28" ry="17" fill="#94a3b8" />
        <circle cx="46" cy="62" r="14" fill="#94a3b8" />
        <circle cx="68" cy="58" r="17" fill="#94a3b8" />
      </svg>
    );
    case 'rainy': return (
      <svg viewBox="0 0 100 100" width={s} height={s} aria-hidden>
        <ellipse cx="50" cy="44" rx="30" ry="18" fill="#64748b" />
        <circle cx="36" cy="40" r="14" fill="#64748b" />
        <circle cx="60" cy="36" r="18" fill="#64748b" />
        {[[34,68],[50,74],[66,68],[42,82],[58,82]].map(([x,y],i) => (
          <line key={i} x1={x} y1={y} x2={x-4} y2={y+10} stroke="#60a5fa" strokeWidth="3" strokeLinecap="round" />
        ))}
      </svg>
    );
    case 'stormy': return (
      <svg viewBox="0 0 100 100" width={s} height={s} aria-hidden>
        <ellipse cx="50" cy="36" rx="30" ry="17" fill="#475569" />
        <circle cx="36" cy="32" r="13" fill="#475569" />
        <circle cx="60" cy="28" r="17" fill="#475569" />
        <path d="M 54 52 L 44 72 L 52 72 L 42 90 L 62 65 L 54 65 Z" fill="#facc15" />
      </svg>
    );
    case 'snowy': return (
      <svg viewBox="0 0 100 100" width={s} height={s} aria-hidden>
        <ellipse cx="50" cy="40" rx="30" ry="18" fill="#94a3b8" />
        <circle cx="36" cy="36" r="14" fill="#94a3b8" />
        <circle cx="60" cy="32" r="18" fill="#94a3b8" />
        {[[32,66],[50,72],[68,66],[40,82],[60,82]].map(([x,y],i) => (
          <text key={i} x={x} y={y} textAnchor="middle" fontSize="14" fill="#bfdbfe">❄</text>
        ))}
      </svg>
    );
    case 'windy': return (
      <svg viewBox="0 0 100 100" width={s} height={s} aria-hidden>
        {[[20,38,70,38],[15,52,80,52],[20,66,60,66]].map(([x1,y1,x2,y2],i) => (
          <path key={i} d={`M ${x1} ${y1} Q ${(x1+x2)/2} ${y1-10} ${x2} ${y1}`} fill="none" stroke="#60a5fa" strokeWidth="4.5" strokeLinecap="round" />
        ))}
      </svg>
    );
    case 'foggy': return (
      <svg viewBox="0 0 100 100" width={s} height={s} aria-hidden>
        {[30,44,58,72].map((y, i) => (
          <line key={i} x1={i%2===0?18:24} y1={y} x2={i%2===0?82:76} y2={y} stroke="#94a3b8" strokeWidth="5" strokeLinecap="round" />
        ))}
      </svg>
    );
    default: return (
      <svg viewBox="0 0 100 100" width={s} height={s} aria-hidden>
        <circle cx="50" cy="50" r="40" fill="#e2e8f0" />
        <text x="50" y="56" textAnchor="middle" fontSize="30" fill="#64748b">?</text>
      </svg>
    );
  }
}

function WeatherCanvas({ data, compact, hideTemp }: { data: WeatherData; compact?: boolean; hideTemp?: boolean }) {
  const isUS = typeof navigator !== 'undefined' && (navigator.language === 'en-US' || navigator.language?.endsWith('-US'));
  const bgColors: Record<string, string> = {
    sunny: 'from-yellow-100 to-orange-50 dark:from-yellow-950 dark:to-orange-950',
    hot: 'from-red-100 to-orange-50 dark:from-red-950 dark:to-orange-950',
    cold: 'from-blue-100 to-cyan-50 dark:from-blue-950 dark:to-cyan-950',
    snowy: 'from-blue-50 to-slate-50 dark:from-blue-950 dark:to-slate-950',
    rainy: 'from-slate-100 to-blue-50 dark:from-slate-900 dark:to-blue-950',
    stormy: 'from-slate-200 to-slate-100 dark:from-slate-900 dark:to-slate-800',
    cloudy: 'from-slate-100 to-slate-50 dark:from-slate-900 dark:to-slate-800',
    partly_cloudy: 'from-sky-100 to-yellow-50 dark:from-sky-950 dark:to-yellow-950',
    windy: 'from-cyan-100 to-sky-50 dark:from-cyan-950 dark:to-sky-950',
    foggy: 'from-slate-100 to-gray-50 dark:from-slate-900 dark:to-gray-900',
  };
  const bg = bgColors[data.condition] ?? 'from-muted to-background';

  if (compact) return (
    <motion.div
      key={data.condition} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45 }}
      className={`flex flex-col items-center gap-1 p-3 rounded-xl bg-gradient-to-br ${bg} min-w-[80px]`}
    >
      <WeatherIcon condition={data.condition} size={44} />
      {data.label && <span className="text-[10px] font-medium text-center leading-tight">{data.label}</span>}
      {!hideTemp && data.celsius !== undefined && (() => {
        const f = Math.round(data.celsius! * 9 / 5 + 32);
        return isUS
          ? <span className="text-[11px] font-mono text-muted-foreground">{f}°F</span>
          : <span className="text-[11px] font-mono text-muted-foreground">{data.celsius}°C</span>;
      })()}
    </motion.div>
  );

  return (
    <motion.div
      key={data.condition}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45 }}
      className={`flex flex-col items-center gap-4 p-8 rounded-2xl bg-gradient-to-br ${bg}`}
    >
      <WeatherIcon condition={data.condition} size={100} />
      {data.label && (
        <span className="text-2xl font-semibold tracking-wide text-center">{data.label}</span>
      )}
      {!hideTemp && data.celsius !== undefined && (() => {
        const f = Math.round(data.celsius! * 9 / 5 + 32);
        return isUS
          ? <span className="text-lg font-mono text-muted-foreground">{f}°F <span className="text-sm opacity-70">({data.celsius}°C)</span></span>
          : <span className="text-lg font-mono text-muted-foreground">{data.celsius}°C</span>;
      })()}
    </motion.div>
  );
}

// ─── Body Diagram Canvas ──────────────────────────────────────────────────────

type SvgShape =
  | { k: 'circle'; cx: number; cy: number; r: number }
  | { k: 'ellipse'; cx: number; cy: number; rx: number; ry: number }
  | { k: 'rect'; x: number; y: number; w: number; h: number; rx?: number }
  | { k: 'path'; d: string };

interface BodyPartSpec {
  aliases: string[];
  shapes: SvgShape[];
  labelX: number; labelY: number;
}

// Organic human figure — tapered bezier paths for limbs/torso, viewBox 200×400
const BODY_PARTS: Record<string, BodyPartSpec> = {
  head:          { aliases: ['cabeza','tête','Kopf','头','頭','rosto'],          shapes: [{ k:'ellipse', cx:100, cy:40, rx:27, ry:31 }],  labelX:136, labelY:40 },
  hair:          { aliases: ['pelo','cabello','cheveux','Haar','头发'],           shapes: [{ k:'path', d:'M74,25 Q76,6 100,5 Q124,6 126,25 Q116,12 100,11 Q84,12 74,25 Z' }], labelX:136, labelY:12 },
  face:          { aliases: ['cara','visage','Gesicht','脸'],                     shapes: [{ k:'ellipse', cx:100, cy:44, rx:21, ry:23 }],  labelX:136, labelY:44 },
  left_eye:      { aliases: ['ojo izquierdo','left eye'],                        shapes: [{ k:'ellipse', cx:91, cy:37, rx:6, ry:5 }],    labelX:55,  labelY:37 },
  right_eye:     { aliases: ['ojo derecho','right eye'],                         shapes: [{ k:'ellipse', cx:109, cy:37, rx:6, ry:5 }],   labelX:136, labelY:37 },
  eyes:          { aliases: ['ojos','yeux','Augen','眼睛','目'],                  shapes: [{ k:'ellipse', cx:91, cy:37, rx:6, ry:5 },{ k:'ellipse', cx:109, cy:37, rx:6, ry:5 }], labelX:136, labelY:37 },
  nose:          { aliases: ['nariz','nez','Nase','鼻子','鼻'],                   shapes: [{ k:'ellipse', cx:100, cy:47, rx:4, ry:5 }],   labelX:136, labelY:47 },
  mouth:         { aliases: ['boca','bouche','Mund','嘴','口'],                   shapes: [{ k:'ellipse', cx:100, cy:57, rx:9, ry:5 }],   labelX:136, labelY:57 },
  ear:           { aliases: ['oreja','oreille','Ohr','耳'],                       shapes: [{ k:'ellipse', cx:72, cy:42, rx:5, ry:8 },{ k:'ellipse', cx:128, cy:42, rx:5, ry:8 }], labelX:136, labelY:42 },
  neck:          { aliases: ['cuello','cou','Hals','脖子','首'],                  shapes: [{ k:'path', d:'M91,70 Q88,79 91,89 L109,89 Q112,79 109,70 Z' }], labelX:136, labelY:79 },
  left_shoulder: { aliases: ['hombro izquierdo'],                                shapes: [{ k:'ellipse', cx:60, cy:100, rx:18, ry:11 }], labelX:28,  labelY:100 },
  right_shoulder:{ aliases: ['hombro derecho'],                                  shapes: [{ k:'ellipse', cx:140, cy:100, rx:18, ry:11 }],labelX:136, labelY:100 },
  shoulders:     { aliases: ['hombros','épaules','Schultern','肩'],               shapes: [{ k:'ellipse', cx:60, cy:100, rx:18, ry:11 },{ k:'ellipse', cx:140, cy:100, rx:18, ry:11 }], labelX:136, labelY:100 },
  chest:         { aliases: ['pecho','poitrine','Brust','胸'],                    shapes: [{ k:'path', d:'M80,89 C58,93 54,112 55,170 Q72,186 100,187 Q128,186 145,170 C146,112 142,93 120,89 Z' }], labelX:136, labelY:128 },
  torso:         { aliases: ['torso','tronc','Rumpf','躯干'],                     shapes: [{ k:'path', d:'M80,89 C58,93 54,112 55,170 Q72,186 100,187 Q128,186 145,170 C146,112 142,93 120,89 Z' }], labelX:136, labelY:138 },
  abdomen:       { aliases: ['estómago','abdomen','ventre','Bauch','お腹','腹'],  shapes: [{ k:'path', d:'M60,184 C58,198 59,215 62,222 L138,222 C141,215 142,198 140,184 Q124,193 100,194 Q76,193 60,184 Z' }], labelX:136, labelY:206 },
  left_arm:      { aliases: ['brazo izquierdo','left arm'],                      shapes: [{ k:'path', d:'M44,107 C38,122 36,138 38,154 L57,158 C61,142 67,124 70,109 Z' }], labelX:24,  labelY:132 },
  right_arm:     { aliases: ['brazo derecho','right arm'],                       shapes: [{ k:'path', d:'M156,107 C162,122 164,138 162,154 L143,158 C139,142 133,124 130,109 Z' }], labelX:136, labelY:132 },
  arms:          { aliases: ['brazos','bras','Arme','腕','手腕'],                 shapes: [{ k:'path', d:'M44,107 C38,122 36,138 38,154 L57,158 C61,142 67,124 70,109 Z' },{ k:'path', d:'M156,107 C162,122 164,138 162,154 L143,158 C139,142 133,124 130,109 Z' }], labelX:136, labelY:132 },
  left_elbow:    { aliases: ['codo izquierdo'],                                  shapes: [{ k:'circle', cx:47, cy:156, r:12 }],          labelX:24,  labelY:156 },
  right_elbow:   { aliases: ['codo derecho'],                                    shapes: [{ k:'circle', cx:153, cy:156, r:12 }],         labelX:136, labelY:156 },
  elbow:         { aliases: ['codo','coude','Ellbogen','肘'],                     shapes: [{ k:'circle', cx:47, cy:156, r:12 },{ k:'circle', cx:153, cy:156, r:12 }], labelX:136, labelY:156 },
  left_forearm:  { aliases: ['antebrazo izquierdo'],                             shapes: [{ k:'path', d:'M38,154 C35,172 37,196 40,214 L57,215 C59,196 60,172 57,158 Z' }], labelX:24,  labelY:186 },
  right_forearm: { aliases: ['antebrazo derecho'],                               shapes: [{ k:'path', d:'M162,154 C165,172 163,196 160,214 L143,215 C141,196 140,172 143,158 Z' }], labelX:136, labelY:186 },
  left_hand:     { aliases: ['mano izquierda'],                                  shapes: [{ k:'ellipse', cx:49, cy:224, rx:15, ry:17 }], labelX:24,  labelY:224 },
  right_hand:    { aliases: ['mano derecha'],                                    shapes: [{ k:'ellipse', cx:151, cy:224, rx:15, ry:17 }],labelX:136, labelY:224 },
  hands:         { aliases: ['manos','mains','Hände','手'],                       shapes: [{ k:'ellipse', cx:49, cy:224, rx:15, ry:17 },{ k:'ellipse', cx:151, cy:224, rx:15, ry:17 }], labelX:136, labelY:224 },
  hips:          { aliases: ['cadera','hanches','Hüfte','腰'],                    shapes: [{ k:'path', d:'M60,184 C58,198 59,215 62,222 L138,222 C141,215 142,198 140,184 Q124,193 100,194 Q76,193 60,184 Z' }], labelX:136, labelY:206 },
  left_leg:      { aliases: ['pierna izquierda'],                                shapes: [{ k:'path', d:'M63,222 C61,252 64,270 68,288 L88,287 C92,269 93,251 95,222 Z' },{ k:'circle', cx:76,cy:290,r:13 },{ k:'path', d:'M65,288 C62,322 64,348 68,368 L86,368 C87,348 88,322 88,288 Z' }], labelX:24,  labelY:278 },
  right_leg:     { aliases: ['pierna derecha'],                                  shapes: [{ k:'path', d:'M137,222 C139,252 136,270 132,288 L112,287 C108,269 107,251 105,222 Z' },{ k:'circle', cx:124,cy:290,r:13 },{ k:'path', d:'M135,288 C138,322 136,348 132,368 L114,368 C112,348 112,322 112,288 Z' }], labelX:136, labelY:278 },
  legs:          { aliases: ['piernas','jambes','Beine','足','脚'],               shapes: [{ k:'path', d:'M63,222 C61,252 64,270 68,288 L88,287 C92,269 93,251 95,222 Z' },{ k:'circle', cx:76,cy:290,r:13 },{ k:'path', d:'M65,288 C62,322 64,348 68,368 L86,368 C87,348 88,322 88,288 Z' },{ k:'path', d:'M137,222 C139,252 136,270 132,288 L112,287 C108,269 107,251 105,222 Z' },{ k:'circle', cx:124,cy:290,r:13 },{ k:'path', d:'M135,288 C138,322 136,348 132,368 L114,368 C112,348 112,322 112,288 Z' }], labelX:136, labelY:278 },
  left_knee:     { aliases: ['rodilla izquierda'],                               shapes: [{ k:'circle', cx:76, cy:290, r:13 }],          labelX:24,  labelY:290 },
  right_knee:    { aliases: ['rodilla derecha'],                                 shapes: [{ k:'circle', cx:124, cy:290, r:13 }],         labelX:136, labelY:290 },
  knee:          { aliases: ['rodilla','genou','Knie','膝'],                      shapes: [{ k:'circle', cx:76, cy:290, r:13 },{ k:'circle', cx:124, cy:290, r:13 }], labelX:136, labelY:290 },
  left_foot:     { aliases: ['pie izquierdo'],                                   shapes: [{ k:'ellipse', cx:77, cy:379, rx:22, ry:11 }], labelX:24,  labelY:382 },
  right_foot:    { aliases: ['pie derecho'],                                     shapes: [{ k:'ellipse', cx:123, cy:379, rx:22, ry:11 }],labelX:136, labelY:382 },
  feet:          { aliases: ['pies','pieds','Füße','足の裏','脚'],                shapes: [{ k:'ellipse', cx:77, cy:379, rx:22, ry:11 },{ k:'ellipse', cx:123, cy:379, rx:22, ry:11 }], labelX:136, labelY:382 },
  back:          { aliases: ['espalda','dos','Rücken','背中','背'],               shapes: [{ k:'path', d:'M80,89 C58,93 54,112 55,170 Q72,186 100,187 Q128,186 145,170 C146,112 142,93 120,89 Z' }], labelX:136, labelY:138 },
};

function resolveBodyParts(parts: string[]): Set<string> {
  const resolved = new Set<string>();
  const lc = parts.map(p => p.toLowerCase());
  for (const [key, spec] of Object.entries(BODY_PARTS)) {
    for (const input of lc) {
      if (input === key || spec.aliases.some(a => a.toLowerCase() === input)) {
        resolved.add(key);
        break;
      }
    }
  }
  if (resolved.size === 0) parts.forEach(p => resolved.add(p.toLowerCase()));
  return resolved;
}

function renderShape(shape: SvgShape, fill: string, stroke: string) {
  switch (shape.k) {
    case 'circle':  return <circle cx={shape.cx} cy={shape.cy} r={shape.r} fill={fill} stroke={stroke} strokeWidth="1.5" />;
    case 'ellipse': return <ellipse cx={shape.cx} cy={shape.cy} rx={shape.rx} ry={shape.ry} fill={fill} stroke={stroke} strokeWidth="1.5" />;
    case 'rect':    return <rect x={shape.x} y={shape.y} width={shape.w} height={shape.h} rx={shape.rx ?? 0} fill={fill} stroke={stroke} strokeWidth="1.5" />;
    case 'path':    return <path d={shape.d} fill={fill} stroke={stroke} strokeWidth="1.5" />;
  }
}

export function BodyDiagramCanvas({ data }: { data: BodyDiagramData }) {
  const highlighted = resolveBodyParts(data.highlightParts);
  const baseFill   = 'hsl(var(--muted))';
  const baseStroke = 'hsl(var(--border))';
  const hlFill     = 'hsl(var(--primary) / 0.78)';
  const hlStroke   = 'hsl(var(--primary))';

  const faceHighlighted = highlighted.has('head') || highlighted.has('face');
  const eyeHighlighted  = faceHighlighted || highlighted.has('eyes') || highlighted.has('left_eye') || highlighted.has('right_eye');
  const mouthHighlighted = faceHighlighted || highlighted.has('mouth');

  const labelParts = Array.from(highlighted).map(key => ({
    key,
    label: (data.labels?.[key]) ?? key.replace(/_/g, ' '),
    nativeLabel: data.nativeLabels?.[key],
  }));

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="flex flex-col items-center gap-2 p-4"
    >
      <svg viewBox="0 0 200 400" className="w-28 sm:w-36" aria-label="Body diagram">
        <defs>
          <filter id="body-hl-glow" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Body parts — organic shapes */}
        {Object.entries(BODY_PARTS).map(([key, spec]) => {
          const isHighlighted = highlighted.has(key);
          const fill   = isHighlighted ? hlFill   : baseFill;
          const stroke = isHighlighted ? hlStroke : baseStroke;
          return (
            <g key={key} filter={isHighlighted ? 'url(#body-hl-glow)' : undefined}>
              {spec.shapes.map((shape, i) => (
                <g key={i}>{renderShape(shape, fill, stroke)}</g>
              ))}
            </g>
          );
        })}

        {/* Always-visible face features — eyes */}
        <ellipse
          cx={91} cy={37} rx={3.5} ry={4}
          fill={eyeHighlighted ? 'hsl(var(--primary-foreground))' : 'hsl(var(--foreground) / 0.45)'}
        />
        <ellipse
          cx={109} cy={37} rx={3.5} ry={4}
          fill={eyeHighlighted ? 'hsl(var(--primary-foreground))' : 'hsl(var(--foreground) / 0.45)'}
        />
        {/* Always-visible face features — smile */}
        <path
          d="M92,54 Q100,61 108,54"
          fill="none"
          stroke={mouthHighlighted ? 'hsl(var(--primary-foreground))' : 'hsl(var(--foreground) / 0.35)'}
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>

      {labelParts.length > 0 && (
        <div className="flex flex-wrap justify-center gap-1.5 mt-1 max-w-52">
          {labelParts.map(({ key, label, nativeLabel }) => (
            <motion.span
              key={key}
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              className="flex flex-col items-center px-2 py-0.5 rounded-full bg-primary text-primary-foreground"
            >
              <span className="text-xs font-semibold leading-tight">{label}</span>
              {nativeLabel && <span className="text-[9px] leading-tight opacity-70">{nativeLabel}</span>}
            </motion.span>
          ))}
        </div>
      )}
    </motion.div>
  );
}

// ─── Face Close-up Canvas ────────────────────────────────────────────────────

// Render order matters: define parts back-to-front so small detail parts sit on top of larger regions.
const FACE_PARTS: Record<string, BodyPartSpec> = {
  // ── back layer: ears behind face ────────────────────────────────────────────
  left_ear:  { aliases: ['oreja izquierda','oreille gauche'],                                   shapes: [{ k:'ellipse', cx:18, cy:128, rx:15, ry:27 }],          labelX:0, labelY:0 },
  right_ear: { aliases: ['oreja derecha','oreille droite'],                                     shapes: [{ k:'ellipse', cx:182, cy:128, rx:15, ry:27 }],         labelX:0, labelY:0 },
  ears:      { aliases: ['orejas','oreilles','Ohren','耳朵','耳'],                               shapes: [{ k:'ellipse', cx:18, cy:128, rx:15, ry:27 },{ k:'ellipse', cx:182, cy:128, rx:15, ry:27 }], labelX:0, labelY:0 },
  // ── hair cap ────────────────────────────────────────────────────────────────
  hair:      { aliases: ['pelo','cabello','cheveux','Haar','头发','髪'],                         shapes: [{ k:'path', d:'M22,112 C22,52 55,18 100,14 C145,18 178,52 178,112 Q162,82 100,76 Q38,82 22,112 Z' }], labelX:0, labelY:0 },
  // ── full face oval ──────────────────────────────────────────────────────────
  face:      { aliases: ['cara','visage','Gesicht','脸','顔','rosto'],                          shapes: [{ k:'ellipse', cx:100, cy:128, rx:78, ry:100 }],         labelX:0, labelY:0 },
  // ── upper / lower face regions ──────────────────────────────────────────────
  forehead:  { aliases: ['frente','front','Stirn','额头','おでこ'],                              shapes: [{ k:'path', d:'M32,104 Q100,82 168,104 L166,122 Q130,112 100,110 Q70,112 34,122 Z' }], labelX:0, labelY:0 },
  jaw:       { aliases: ['mandíbula','mâchoire','Kiefer','下颌'],                               shapes: [{ k:'path', d:'M28,156 Q18,186 38,208 Q64,228 100,230 Q136,228 162,208 Q182,186 172,156 Q150,176 100,180 Q50,176 28,156 Z' }], labelX:0, labelY:0 },
  left_cheek:  { aliases: ['mejilla izquierda'],                                               shapes: [{ k:'ellipse', cx:44, cy:158, rx:28, ry:24 }],          labelX:0, labelY:0 },
  right_cheek: { aliases: ['mejilla derecha'],                                                 shapes: [{ k:'ellipse', cx:156, cy:158, rx:28, ry:24 }],         labelX:0, labelY:0 },
  cheeks:    { aliases: ['mejillas','pommettes','Wangen','脸颊','頬'],                           shapes: [{ k:'ellipse', cx:44, cy:158, rx:28, ry:24 },{ k:'ellipse', cx:156, cy:158, rx:28, ry:24 }], labelX:0, labelY:0 },
  chin:      { aliases: ['mentón','menton','Kinn','下巴','あご'],                               shapes: [{ k:'ellipse', cx:100, cy:214, rx:30, ry:16 }],         labelX:0, labelY:0 },
  // ── eyes + brows ────────────────────────────────────────────────────────────
  left_eyebrow:  { aliases: ['ceja izquierda'],                                               shapes: [{ k:'path', d:'M44,103 C58,93 80,91 97,98 C82,104 58,105 44,103 Z' }], labelX:0, labelY:0 },
  right_eyebrow: { aliases: ['ceja derecha'],                                                 shapes: [{ k:'path', d:'M103,98 C120,91 142,93 156,103 C142,105 118,104 103,98 Z' }], labelX:0, labelY:0 },
  eyebrows:  { aliases: ['cejas','sourcils','Augenbrauen','眉毛','眉'],                          shapes: [{ k:'path', d:'M44,103 C58,93 80,91 97,98 C82,104 58,105 44,103 Z' },{ k:'path', d:'M103,98 C120,91 142,93 156,103 C142,105 118,104 103,98 Z' }], labelX:0, labelY:0 },
  left_eye:  { aliases: ['ojo izquierdo','left eye'],                                          shapes: [{ k:'path', d:'M44,116 Q68,106 92,116 Q68,126 44,116 Z' }], labelX:0, labelY:0 },
  right_eye: { aliases: ['ojo derecho','right eye'],                                           shapes: [{ k:'path', d:'M108,116 Q132,106 156,116 Q132,126 108,116 Z' }], labelX:0, labelY:0 },
  eyes:      { aliases: ['ojos','yeux','Augen','眼睛','目'],                                    shapes: [{ k:'path', d:'M44,116 Q68,106 92,116 Q68,126 44,116 Z' },{ k:'path', d:'M108,116 Q132,106 156,116 Q132,126 108,116 Z' }], labelX:0, labelY:0 },
  // ── nose ────────────────────────────────────────────────────────────────────
  nose:      { aliases: ['nariz','nez','Nase','鼻子','鼻'],                                     shapes: [{ k:'path', d:'M97,120 Q95,132 90,142 Q94,153 100,155 Q106,153 110,142 Q105,132 103,120 Z' }], labelX:0, labelY:0 },
  // ── mouth ───────────────────────────────────────────────────────────────────
  upper_lip: { aliases: ['labio superior'],                                                     shapes: [{ k:'path', d:'M67,162 Q100,152 133,162 Q117,170 100,172 Q83,170 67,162 Z' }], labelX:0, labelY:0 },
  lower_lip: { aliases: ['labio inferior'],                                                     shapes: [{ k:'path', d:'M67,172 Q83,180 100,182 Q117,180 133,172 Q116,177 100,178 Q84,177 67,172 Z' }], labelX:0, labelY:0 },
  lips:      { aliases: ['labios','lèvres','Lippen','嘴唇','唇'],                               shapes: [{ k:'path', d:'M67,162 Q100,152 133,162 Q117,170 100,172 Q83,170 67,162 Z' },{ k:'path', d:'M67,172 Q83,180 100,182 Q117,180 133,172 Q116,177 100,178 Q84,177 67,172 Z' }], labelX:0, labelY:0 },
  teeth:     { aliases: ['dientes','dents','Zähne','牙齿','歯'],                                shapes: [{ k:'rect', x:83, y:172, w:34, h:9, rx:4 }],           labelX:0, labelY:0 },
  mouth:     { aliases: ['boca','bouche','Mund','嘴','口'],                                     shapes: [{ k:'path', d:'M67,162 Q100,152 133,162 Q117,170 100,172 Q83,170 67,162 Z' },{ k:'rect', x:83, y:172, w:34, h:9, rx:4 },{ k:'path', d:'M67,172 Q83,180 100,182 Q117,180 133,172 Q116,177 100,178 Q84,177 67,172 Z' }], labelX:0, labelY:0 },
};

function resolveFaceParts(parts: string[]): Set<string> {
  const resolved = new Set<string>();
  const lc = parts.map(p => p.toLowerCase());
  for (const [key, spec] of Object.entries(FACE_PARTS)) {
    for (const input of lc) {
      if (input === key || spec.aliases.some(a => a.toLowerCase() === input)) {
        resolved.add(key);
        break;
      }
    }
  }
  if (resolved.size === 0) parts.forEach(p => resolved.add(p.toLowerCase()));
  return resolved;
}

export function FaceDiagramCanvas({ data }: { data: FaceDiagramData }) {
  const highlighted = resolveFaceParts(data.highlightParts);
  const baseFill   = 'hsl(var(--muted))';
  const baseStroke = 'hsl(var(--border))';
  const hlFill     = 'hsl(var(--primary) / 0.78)';
  const hlStroke   = 'hsl(var(--primary))';

  const eyeHl   = highlighted.has('left_eye') || highlighted.has('right_eye') || highlighted.has('eyes') || highlighted.has('face');
  const mouthHl = highlighted.has('mouth') || highlighted.has('lips') || highlighted.has('upper_lip') || highlighted.has('lower_lip') || highlighted.has('teeth');
  const noseHl  = highlighted.has('nose') || highlighted.has('face');

  const labelParts = Array.from(highlighted).map(key => ({
    key,
    label: (data.labels?.[key]) ?? key.replace(/_/g, ' '),
    nativeLabel: data.nativeLabels?.[key],
  }));

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center gap-2 p-4">
      <svg viewBox="0 0 200 244" className="w-28 sm:w-36" aria-label="Face close-up diagram">
        <defs>
          <filter id="face-hl-glow" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="3.5" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>

        {Object.entries(FACE_PARTS).map(([key, spec]) => {
          const isHl = highlighted.has(key);
          return (
            <g key={key} filter={isHl ? 'url(#face-hl-glow)' : undefined}>
              {spec.shapes.map((shape, i) => (
                <g key={i}>{renderShape(shape, isHl ? hlFill : baseFill, isHl ? hlStroke : baseStroke)}</g>
              ))}
            </g>
          );
        })}

        {/* Always-visible eye details */}
        <ellipse cx={68} cy={116} rx={5} ry={6} fill={eyeHl ? 'hsl(var(--primary-foreground))' : 'hsl(var(--foreground) / 0.55)'} />
        <circle  cx={70} cy={114} r={1.5} fill={eyeHl ? 'hsl(var(--primary) / 0.5)' : 'hsl(var(--background) / 0.6)'} />
        <ellipse cx={132} cy={116} rx={5} ry={6} fill={eyeHl ? 'hsl(var(--primary-foreground))' : 'hsl(var(--foreground) / 0.55)'} />
        <circle  cx={134} cy={114} r={1.5} fill={eyeHl ? 'hsl(var(--primary) / 0.5)' : 'hsl(var(--background) / 0.6)'} />

        {/* Always-visible nostril dots */}
        <ellipse cx={92} cy={146} rx={4.5} ry={3} fill={noseHl ? 'hsl(var(--primary-foreground) / 0.5)' : 'hsl(var(--foreground) / 0.2)'} />
        <ellipse cx={108} cy={146} rx={4.5} ry={3} fill={noseHl ? 'hsl(var(--primary-foreground) / 0.5)' : 'hsl(var(--foreground) / 0.2)'} />

        {/* Always-visible smile line */}
        <path d="M80,168 Q100,175 120,168" fill="none"
          stroke={mouthHl ? 'hsl(var(--primary-foreground) / 0.6)' : 'hsl(var(--foreground) / 0.25)'}
          strokeWidth="1.5" strokeLinecap="round" />
      </svg>

      {labelParts.length > 0 && (
        <div className="flex flex-wrap justify-center gap-1.5 mt-1 max-w-52">
          {labelParts.map(({ key, label, nativeLabel }) => (
            <motion.span key={key} initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }}
              className="flex flex-col items-center px-2 py-0.5 rounded-full bg-primary text-primary-foreground">
              <span className="text-xs font-semibold leading-tight">{label}</span>
              {nativeLabel && <span className="text-[9px] leading-tight opacity-70">{nativeLabel}</span>}
            </motion.span>
          ))}
        </div>
      )}
    </motion.div>
  );
}

// ─── Hand Close-up Canvas ────────────────────────────────────────────────────

// Dorsal (back of hand) view, fingers pointing up, right hand by default.
// Render order: wrist → palm → thumb → fingers → knuckles → fingernails (front-most)
const HAND_PARTS: Record<string, BodyPartSpec> = {
  wrist:         { aliases: ['muñeca','poignet','Handgelenk','手腕','手首'],                     shapes: [{ k:'path', d:'M60,240 C58,262 62,282 68,287 L132,287 C138,282 142,262 140,240 Z' }], labelX:0, labelY:0 },
  palm:          { aliases: ['palma','paume','Handfläche','手掌','掌'],                           shapes: [{ k:'path', d:'M48,124 C44,156 46,200 60,240 L140,240 C154,200 156,156 152,124 Q138,112 100,110 Q62,112 48,124 Z' }], labelX:0, labelY:0 },
  thumb:         { aliases: ['pulgar','pouce','Daumen','拇指','親指'],                            shapes: [{ k:'path', d:'M48,130 C40,116 34,96 36,74 C38,58 48,52 58,60 C68,70 68,92 64,126 Z' }], labelX:0, labelY:0 },
  index_finger:  { aliases: ['dedo índice','index','Zeigefinger','食指','人差し指','pointer','index finger','índice'], shapes: [{ k:'path', d:'M66,114 C64,92 64,58 66,36 C68,24 78,22 84,26 C90,30 90,54 88,82 L88,114 Z' }], labelX:0, labelY:0 },
  middle_finger: { aliases: ['dedo medio','majeur','Mittelfinger','中指'],                       shapes: [{ k:'path', d:'M92,110 C90,88 90,50 92,26 C94,14 106,14 108,26 C110,50 110,88 108,110 Z' }], labelX:0, labelY:0 },
  ring_finger:   { aliases: ['dedo anular','annulaire','Ringfinger','无名指','薬指'],             shapes: [{ k:'path', d:'M112,112 C112,90 112,56 114,36 C116,24 126,22 130,28 C136,34 134,62 132,90 L130,112 Z' }], labelX:0, labelY:0 },
  pinky:         { aliases: ['meñique','auriculaire','kleiner Finger','小指','little finger'],   shapes: [{ k:'path', d:'M134,120 C133,100 134,78 136,60 C138,48 148,46 154,54 C160,62 158,84 154,114 Z' }], labelX:0, labelY:0 },
  fingers:       { aliases: ['dedos','doigts','Finger','手指','指'],                              shapes: [{ k:'path', d:'M66,114 C64,92 64,58 66,36 C68,24 78,22 84,26 C90,30 90,54 88,82 L88,114 Z' },{ k:'path', d:'M92,110 C90,88 90,50 92,26 C94,14 106,14 108,26 C110,50 110,88 108,110 Z' },{ k:'path', d:'M112,112 C112,90 112,56 114,36 C116,24 126,22 130,28 C136,34 134,62 132,90 L130,112 Z' },{ k:'path', d:'M134,120 C133,100 134,78 136,60 C138,48 148,46 154,54 C160,62 158,84 154,114 Z' }], labelX:0, labelY:0 },
  knuckles:      { aliases: ['nudillos','articulations','Knöchel','指关节','ナックル'],            shapes: [{ k:'circle', cx:77, cy:114, r:9 },{ k:'circle', cx:100, cy:110, r:9 },{ k:'circle', cx:121, cy:112, r:9 },{ k:'circle', cx:141, cy:120, r:9 }], labelX:0, labelY:0 },
  fingernails:   { aliases: ['uñas','ongles','Fingernägel','指甲','爪'],                         shapes: [{ k:'ellipse', cx:53, cy:64, rx:8, ry:9 },{ k:'ellipse', cx:77, cy:31, rx:7, ry:9 },{ k:'ellipse', cx:100, cy:21, rx:7, ry:9 },{ k:'ellipse', cx:121, cy:31, rx:7, ry:9 },{ k:'ellipse', cx:144, cy:55, rx:6, ry:8 }], labelX:0, labelY:0 },
};

function resolveHandParts(parts: string[]): Set<string> {
  const resolved = new Set<string>();
  const lc = parts.map(p => p.toLowerCase());
  for (const [key, spec] of Object.entries(HAND_PARTS)) {
    for (const input of lc) {
      if (input === key || spec.aliases.some(a => a.toLowerCase() === input)) {
        resolved.add(key);
        break;
      }
    }
  }
  if (resolved.size === 0) parts.forEach(p => resolved.add(p.toLowerCase()));
  return resolved;
}

export function HandDiagramCanvas({ data }: { data: HandDiagramData }) {
  const highlighted = resolveHandParts(data.highlightParts);
  const baseFill   = 'hsl(var(--muted))';
  const baseStroke = 'hsl(var(--border))';
  const hlFill     = 'hsl(var(--primary) / 0.78)';
  const hlStroke   = 'hsl(var(--primary))';

  // Mirror transform for left hand
  const mirror = data.hand === 'left';
  const transform = mirror ? 'scale(-1,1) translate(-200,0)' : undefined;

  const labelParts = Array.from(highlighted).map(key => ({
    key,
    label: (data.labels?.[key]) ?? key.replace(/_/g, ' '),
    nativeLabel: data.nativeLabels?.[key],
  }));

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center gap-2 p-4">
      <svg viewBox="0 0 200 295" className="w-24 sm:w-32" aria-label="Hand diagram">
        <defs>
          <filter id="hand-hl-glow" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="3.5" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        <g transform={transform}>
          {Object.entries(HAND_PARTS).map(([key, spec]) => {
            const isHl = highlighted.has(key);
            return (
              <g key={key} filter={isHl ? 'url(#hand-hl-glow)' : undefined}>
                {spec.shapes.map((shape, i) => (
                  <g key={i}>{renderShape(shape, isHl ? hlFill : baseFill, isHl ? hlStroke : baseStroke)}</g>
                ))}
              </g>
            );
          })}

          {/* Always-visible finger crease lines on palm */}
          {[78, 100, 121].map((x, i) => (
            <line key={i}
              x1={x} y1={115} x2={x} y2={135}
              stroke="hsl(var(--foreground) / 0.12)" strokeWidth="1.5" strokeLinecap="round"
            />
          ))}

          {/* Always-visible fingernail detail lines */}
          {[
            { cx: 77, cy: 31 }, { cx: 100, cy: 21 }, { cx: 121, cy: 31 }, { cx: 144, cy: 55 }
          ].map((n, i) => (
            <line key={i}
              x1={n.cx - 4} y1={n.cy + 6} x2={n.cx + 4} y2={n.cy + 6}
              stroke="hsl(var(--foreground) / 0.15)" strokeWidth="1" strokeLinecap="round"
            />
          ))}
        </g>
      </svg>

      {labelParts.length > 0 && (
        <div className="flex flex-wrap justify-center gap-1.5 mt-1 max-w-52">
          {labelParts.map(({ key, label, nativeLabel }) => (
            <motion.span key={key} initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }}
              className="flex flex-col items-center px-2 py-0.5 rounded-full bg-primary text-primary-foreground">
              <span className="text-xs font-semibold leading-tight">{label}</span>
              {nativeLabel && <span className="text-[9px] leading-tight opacity-70">{nativeLabel}</span>}
            </motion.span>
          ))}
        </div>
      )}
    </motion.div>
  );
}

// ─── World Map Canvas ─────────────────────────────────────────────────────────

interface CountryDef { x: number; y: number; name: string; short: string }
const WORLD_COUNTRIES: Record<string, CountryDef> = {
  spain:               { x:222, y:46,  name:'España',           short:'ES' },
  mexico:              { x:58,  y:102, name:'México',           short:'MX' },
  guatemala:           { x:67,  y:122, name:'Guatemala',        short:'GT' },
  honduras:            { x:77,  y:131, name:'Honduras',         short:'HN' },
  el_salvador:         { x:65,  y:140, name:'El Salvador',      short:'SV' },
  nicaragua:           { x:74,  y:150, name:'Nicaragua',        short:'NI' },
  costa_rica:          { x:74,  y:161, name:'Costa Rica',       short:'CR' },
  panama:              { x:82,  y:172, name:'Panamá',           short:'PA' },
  cuba:                { x:118, y:103, name:'Cuba',             short:'CU' },
  dominican_republic:  { x:140, y:112, name:'Rep. Dom.',        short:'DO' },
  puerto_rico:         { x:158, y:116, name:'Puerto Rico',      short:'PR' },
  colombia:            { x:98,  y:186, name:'Colombia',         short:'CO' },
  venezuela:           { x:127, y:175, name:'Venezuela',        short:'VE' },
  ecuador:             { x:84,  y:204, name:'Ecuador',          short:'EC' },
  peru:                { x:90,  y:222, name:'Perú',             short:'PE' },
  bolivia:             { x:112, y:242, name:'Bolivia',          short:'BO' },
  chile:               { x:94,  y:278, name:'Chile',            short:'CL' },
  argentina:           { x:116, y:312, name:'Argentina',        short:'AR' },
  uruguay:             { x:136, y:314, name:'Uruguay',          short:'UY' },
  paraguay:            { x:125, y:268, name:'Paraguay',         short:'PY' },
  equatorial_guinea:   { x:206, y:176, name:'Guinea Ec.',       short:'GQ' },
  philippines:         { x:272, y:104, name:'Filipinas',        short:'PH' },
  western_sahara:      { x:210, y:88,  name:'Sáhara Occidental',short:'EH' },
};

export function WorldMapCanvas({ data }: { data: WorldMapData }) {
  const hlSlugs = new Set(data.highlightCountries.map(s => s.toLowerCase().replace(/ /g,'_').replace(/-/g,'_')));
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="flex flex-col items-center gap-3 p-4 w-full"
    >
      <svg viewBox="0 0 310 370" className="w-full max-w-sm" aria-label="Spanish-speaking countries map">
        {/* Ocean background */}
        <rect x="0" y="0" width="310" height="370" fill="hsl(var(--primary) / 0.06)" rx="8" />
        {/* Simplified continent silhouettes */}
        {/* North + Central America */}
        <path d="M 18 55 L 55 38 L 95 30 L 140 40 L 148 58 L 134 72 L 104 82 L 84 95 L 92 110 L 100 130 L 92 175 L 82 178 L 74 162 L 60 150 L 50 118 L 36 92 Z" fill="hsl(var(--muted))" stroke="hsl(var(--border))" strokeWidth="0.8" />
        {/* Caribbean (rough outline) */}
        <ellipse cx="118" cy="103" rx="8" ry="4" fill="hsl(var(--muted))" />
        <ellipse cx="140" cy="112" rx="5" ry="3" fill="hsl(var(--muted))" />
        {/* South America */}
        <path d="M 86 182 L 144 172 L 168 200 L 175 255 L 165 320 L 148 348 L 122 350 L 98 328 L 76 280 L 76 234 L 84 200 Z" fill="hsl(var(--muted))" stroke="hsl(var(--border))" strokeWidth="0.8" />
        {/* Europe (Spain area) */}
        <rect x="200" y="34" width="36" height="24" rx="4" fill="hsl(var(--muted))" stroke="hsl(var(--border))" strokeWidth="0.8" />
        {/* Africa (for Equatorial Guinea) */}
        <rect x="190" y="162" width="40" height="36" rx="4" fill="hsl(var(--muted))" stroke="hsl(var(--border))" strokeWidth="0.8" />
        {/* Philippines */}
        <rect x="260" y="90" width="24" height="28" rx="4" fill="hsl(var(--muted))" stroke="hsl(var(--border))" strokeWidth="0.8" />

        {/* Country dots */}
        {Object.entries(WORLD_COUNTRIES).map(([slug, c]) => {
          const isHl = hlSlugs.has(slug);
          const label = (data.labels?.[slug]) ?? (isHl ? c.name : c.short);
          return (
            <motion.g key={slug} initial={isHl ? { scale: 0.5 } : { scale: 1 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 200, damping: 14 }}>
              <circle cx={c.x} cy={c.y} r={isHl ? 8 : 5}
                fill={isHl ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground) / 0.35)'}
                stroke={isHl ? 'hsl(var(--primary-foreground) / 0.6)' : 'none'}
                strokeWidth="1.5"
              />
              {isHl && (
                <>
                  <rect x={c.x + 11} y={c.y - 8} width={label.length * 5.5 + 6} height="14" rx="3"
                    fill="hsl(var(--primary))" />
                  <text x={c.x + 14} y={c.y + 2} fontSize="8" fill="hsl(var(--primary-foreground))"
                    fontFamily="system-ui,sans-serif" fontWeight="600">{label}</text>
                </>
              )}
              {!isHl && (
                <text x={c.x} y={c.y + 16} textAnchor="middle" fontSize="6"
                  fill="hsl(var(--muted-foreground) / 0.7)" fontFamily="system-ui,sans-serif">{c.short}</text>
              )}
            </motion.g>
          );
        })}
      </svg>
      {hlSlugs.size > 0 && (
        <div className="flex flex-wrap justify-center gap-1.5">
          {Array.from(hlSlugs).map(slug => {
            const c = WORLD_COUNTRIES[slug];
            if (!c) return null;
            const label = data.labels?.[slug] ?? c.name;
            return (
              <span key={slug} className="px-2 py-0.5 rounded-full bg-primary text-primary-foreground text-xs font-semibold">
                {label}
              </span>
            );
          })}
        </div>
      )}
    </motion.div>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────

interface SceneCanvasProps {
  data: SceneCanvasItemData;
  "data-testid"?: string;
}

export function SceneCanvas({ data, "data-testid": testId }: SceneCanvasProps) {
  const hasBackground = Boolean(data.environmentImageUrl);
  const hasProps = data.props.length > 0;
  const hasClock = Boolean(data.clockTime);
  const hasConjugation = Boolean(data.conjugationTable);
  const hasCalendar = Boolean(data.calendarData);
  const hasBody = Boolean(data.bodyDiagram);
  const hasFace = Boolean(data.faceDiagram);
  const hasHand = Boolean(data.handDiagram);
  const hasThermometer = Boolean(data.thermometerData);
  const hasEmotion = Boolean(data.emotionData);
  const hasWeather = Boolean(data.weatherData);
  const hasWorldMap = Boolean(data.worldMapData);

  // ── Standalone grammar/visual canvas modes (no spatial scene active) ─────────
  // Large exclusive widgets: rendered alone (too big to stack side by side).
  // Small widgets (clock, thermometer, weather, emotion): can coexist — rendered in a flex row.
  if (!hasBackground && !hasProps) {
    if (hasBody) return <div data-testid={testId} className="w-full min-h-32"><BodyDiagramCanvas data={data.bodyDiagram!} /></div>;
    if (hasFace) return <div data-testid={testId} className="w-full min-h-32 flex justify-center"><FaceDiagramCanvas data={data.faceDiagram!} /></div>;
    if (hasHand) return <div data-testid={testId} className="w-full min-h-32 flex justify-center"><HandDiagramCanvas data={data.handDiagram!} /></div>;
    if (hasWorldMap) return <div data-testid={testId} className="w-full"><WorldMapCanvas data={data.worldMapData!} /></div>;
    if (hasConjugation) return <div data-testid={testId} className="w-full min-h-32"><ConjugationTableCanvas table={data.conjugationTable!} /></div>;
    if (hasCalendar) return <div data-testid={testId} className="w-full min-h-32"><CalendarCanvas cal={data.calendarData!} /></div>;

    // Small widgets — count first so we know whether to use compact ribbon mode
    const activeSmallCount = [hasThermometer, hasEmotion, hasWeather, hasClock].filter(Boolean).length;
    const useCompact = activeSmallCount >= 1; // always compact — full mode overflows the 280px Studio panel

    const smallWidgets = [
      hasThermometer && <ThermometerCanvas key="therm" data={data.thermometerData!} compact={useCompact} />,
      // Alone in the Studio panel, the face has room for its full size (it fits within 280px).
      hasEmotion && <EmotionFaceCanvas key="emotion" data={data.emotionData!} compact={activeSmallCount >= 2} />,
      hasWeather && <WeatherCanvas key="weather" data={data.weatherData!} compact={useCompact} hideTemp={hasThermometer} />,
      hasClock && <ClockOnlyCanvas key="clock" time={data.clockTime!} label={data.clockLabel} showLabel={data.clockShowLabel} compact={useCompact} />,
    ].filter(Boolean) as React.ReactNode[];

    if (smallWidgets.length === 1) {
      return <div data-testid={testId} className="flex justify-center p-2">{smallWidgets[0]}</div>;
    }
    if (smallWidgets.length > 1) {
      return (
        <div data-testid={testId} className="flex flex-row flex-wrap justify-center items-center gap-2 p-2">
          {smallWidgets}
        </div>
      );
    }
  }

  // ── Full spatial scene canvas ────────────────────────────────────────────────
  return (
    <div
      data-testid={testId}
      className="relative w-full rounded-lg overflow-hidden bg-muted"
      style={{ aspectRatio: "16 / 9" }}
    >
      {hasBackground && (
        <img
          src={data.environmentImageUrl}
          alt={data.environmentLabel || data.environment.replace(/_/g, " ")}
          className="absolute inset-0 w-full h-full object-cover"
          draggable={false}
        />
      )}

      <AnimatePresence>
        {data.props.map((prop) => (
          <PropLayer key={prop.name} prop={prop} />
        ))}
      </AnimatePresence>

      {/* Clock floats as its own card only when no other overlay panel is present.
          When other widgets are active the clock is folded into the panel below
          so they don't stack on top of each other. */}
      {hasClock && !(hasConjugation || hasCalendar || hasBody || hasFace || hasHand || hasWorldMap || hasThermometer || hasEmotion || hasWeather) && (
        <motion.div
          key={data.clockTime}
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.4 }}
          className="absolute"
          style={{ right: "5%", top: "5%", width: "22%" }}
        >
          <div className="bg-white/92 backdrop-blur-sm rounded-xl p-2 shadow-lg">
            <AnalogClock time={data.clockTime!} />
            <p className="text-center text-[10px] font-mono text-gray-600 mt-1 leading-none">
              {formatTime12h(data.clockTime!)}
            </p>
            {data.clockShowLabel !== false && data.clockLabel && (
              <p className="text-center text-[11px] font-semibold text-gray-800 mt-0.5 leading-tight">
                {data.clockLabel}
              </p>
            )}
          </div>
        </motion.div>
      )}

      {/* Phase 2 overlays on top of spatial scene (right side panel).
          Clock is included at the top of this panel when other widgets are also present. */}
      {(hasConjugation || hasCalendar || hasBody || hasFace || hasHand || hasWorldMap || hasThermometer || hasEmotion || hasWeather) && (
        <motion.div
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          className="absolute right-2 top-2 bottom-2 w-44 sm:w-52 bg-background/95 backdrop-blur-sm rounded-lg shadow-lg overflow-auto"
        >
          {hasClock && (
            <div className="flex justify-center px-2 pt-2 pb-1 border-b border-border/40">
              <ClockOnlyCanvas time={data.clockTime!} label={data.clockLabel} showLabel={data.clockShowLabel} compact />
            </div>
          )}
          {hasConjugation && <ConjugationTableCanvas table={data.conjugationTable!} />}
          {hasCalendar && <CalendarCanvas cal={data.calendarData!} />}
          {hasBody && <BodyDiagramCanvas data={data.bodyDiagram!} />}
          {hasFace && <FaceDiagramCanvas data={data.faceDiagram!} />}
          {hasHand && <HandDiagramCanvas data={data.handDiagram!} />}
          {hasWorldMap && <WorldMapCanvas data={data.worldMapData!} />}
          {hasThermometer && <ThermometerCanvas data={data.thermometerData!} />}
          {hasEmotion && <EmotionFaceCanvas data={data.emotionData!} />}
          {hasWeather && <WeatherCanvas data={data.weatherData!} hideTemp={hasThermometer} />}
        </motion.div>
      )}
    </div>
  );
}
