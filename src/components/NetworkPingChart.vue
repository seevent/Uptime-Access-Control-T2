<template>
    <div class="network-ping-chart">
        <ul class="legend" :aria-label="$t('networkHistoryLegend')">
            <template v-if="series.length === 1">
                <li>
                    <span class="swatch line" :style="{ background: colorOf(0) }"></span>
                    {{ $t("networkPingAverage") }}
                </li>
                <li>
                    <span class="swatch band" :style="{ background: colorOf(0) }"></span>
                    {{ $t("networkPingBand") }}
                </li>
            </template>
            <template v-else>
                <li v-for="(s, index) in series" :key="s.deviceId">
                    <span class="swatch line" :style="{ background: colorOf(index, s) }"></span>
                    {{ s.label }}
                </li>
            </template>
        </ul>
        <div class="chart-wrapper" role="img" :aria-label="ariaLabel">
            <Line :data="chartData" :options="chartOptions" />
        </div>
    </div>
</template>

<script lang="js">
import { Chart, Filler, LineController, LineElement, LinearScale, PointElement, TimeScale, Tooltip } from "chart.js";
import "chartjs-adapter-dayjs-4";
import { Line } from "vue-chartjs";
import { formatPing, pingChartPoints } from "../network-ping-format.js";

Chart.register(LineController, LineElement, PointElement, LinearScale, TimeScale, Tooltip, Filler);

// Categorical palette in fixed order (checked for colour-blind separation on both surfaces)
const DAY_MS = 86400000;
const PALETTE_LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4"];
const PALETTE_DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181"];

export default {
    components: { Line },
    props: {
        /** Lines to draw: {deviceId, label, colorIndex?, points: [time, avg, min, max, up, down][]} */
        series: {
            type: Array,
            default: () => [],
        },
        /** Seconds between two points, to see where the data has a hole */
        stepSeconds: {
            type: Number,
            default: 60,
        },
        ariaLabel: {
            type: String,
            default: "",
        },
    },
    computed: {
        isLight() {
            return this.$root.theme === "light";
        },

        palette() {
            return this.isLight ? PALETTE_LIGHT : PALETTE_DARK;
        },

        prepared() {
            return this.series.map((s) => ({ ...s, chartPoints: pingChartPoints(s.points, this.stepSeconds) }));
        },

        // The time of the first and the last point decide how the axis writes the time
        spanMs() {
            let min = Infinity;
            let max = -Infinity;
            for (const s of this.prepared) {
                for (const p of s.chartPoints) {
                    min = Math.min(min, p.x);
                    max = Math.max(max, p.x);
                }
            }
            return max > min ? max - min : 0;
        },

        // Up to two days the clock is enough; a little longer needs the date too; beyond that one tick is one day
        tickFormat() {
            if (this.spanMs <= 2 * DAY_MS) {
                return "HH:mm";
            }
            return this.spanMs <= 3 * DAY_MS ? "MM-DD HH:mm" : "MM-DD";
        },

        chartData() {
            const datasets = [];
            if (this.prepared.length === 1) {
                // The band goes first: its "max" line fills down to the "min" line that follows it
                const color = this.colorOf(0);
                const points = this.prepared[0].chartPoints;
                datasets.push({
                    label: "max",
                    data: points.map((p) => ({ x: p.x, y: p.max })),
                    borderWidth: 0,
                    pointRadius: 0,
                    pointHoverRadius: 0,
                    backgroundColor: this.withAlpha(color, 0.18),
                    fill: "+1",
                    spanGaps: false,
                    isBand: true,
                });
                datasets.push({
                    label: "min",
                    data: points.map((p) => ({ x: p.x, y: p.min })),
                    borderWidth: 0,
                    pointRadius: 0,
                    pointHoverRadius: 0,
                    fill: false,
                    spanGaps: false,
                    isBand: true,
                });
            }
            this.prepared.forEach((s, index) => {
                const color = this.colorOf(index, s);
                datasets.push({
                    label: s.label,
                    data: s.chartPoints,
                    borderColor: color,
                    backgroundColor: color,
                    borderWidth: 2,
                    tension: 0,
                    pointRadius: s.chartPoints.length <= 40 ? 3 : 0,
                    pointHoverRadius: 5,
                    pointHitRadius: 10,
                    pointBackgroundColor: color,
                    fill: false,
                    spanGaps: false,
                });
            });
            return { datasets };
        },

        chartOptions() {
            const text = this.isLight ? "#4b5563" : "#b1b8c0";
            const grid = this.isLight ? "rgba(0,0,0,0.1)" : "rgba(255,255,255,0.1)";
            return {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                parsing: false,
                interaction: { mode: "index", intersect: false, axis: "x" },
                scales: {
                    x: {
                        type: "time",
                        // Long ranges get one tick per day, so a date is never written twice
                        time: this.spanMs > 3 * DAY_MS ? { unit: "day" } : {},
                        grid: { display: false },
                        ticks: {
                            color: text,
                            maxRotation: 0,
                            autoSkipPadding: 20,
                            callback: (value) => this.$root.datetimeFormat(value, this.tickFormat),
                        },
                    },
                    y: {
                        beginAtZero: true,
                        grid: { color: grid },
                        title: { display: true, text: this.$t("networkPingAxis"), color: text },
                        ticks: { color: text },
                    },
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: this.isLight ? "rgba(212,232,222,1.0)" : "rgba(32,42,38,1.0)",
                        titleColor: this.isLight ? "rgba(12,12,18,1.0)" : "rgba(220,220,220,1.0)",
                        bodyColor: this.isLight ? "rgba(12,12,18,1.0)" : "rgba(220,220,220,1.0)",
                        filter: (item) => !item.dataset.isBand && item.raw && item.raw.y !== null,
                        callbacks: {
                            title: (items) => (items.length ? this.timeText(items[0].raw.x) : ""),
                            label: (item) => this.tooltipLines(item),
                        },
                    },
                },
            };
        },
    },
    methods: {
        colorOf(index, series) {
            const i = series && Number.isInteger(series.colorIndex) ? series.colorIndex : index;
            return this.palette[i % this.palette.length];
        },

        withAlpha(hex, alpha) {
            const n = parseInt(hex.slice(1), 16);
            return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
        },

        timeText(ms) {
            let format = "YYYY-MM-DD HH:mm";
            if (this.stepSeconds >= 86400) {
                format = "YYYY-MM-DD";
            } else if (this.stepSeconds >= 3600) {
                format = "YYYY-MM-DD HH:00";
            }
            return this.$root.datetimeFormat(ms, format);
        },

        tooltipLines(item) {
            const p = item.raw;
            const locale = this.$i18n.locale;
            const lines = [
                `${item.dataset.label}: ${this.$t("networkPingAverage")} ${formatPing(p.y, locale)}`,
                `${this.$t("networkPingLowest")} ${formatPing(p.min, locale)} · ${this.$t("networkPingHighest")} ${formatPing(p.max, locale)}`,
                `${this.$t("networkPingChecks", { up: p.up, down: p.down })}`,
            ];
            return lines;
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../assets/vars.scss";

.legend {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 1rem;
    list-style: none;
    margin: 0 0 0.5rem;
    padding: 0;
    font-size: 0.85rem;
}

.swatch {
    display: inline-block;
    vertical-align: middle;
    margin-right: 0.35rem;

    &.line {
        width: 1.1rem;
        height: 3px;
        border-radius: 2px;
    }

    &.band {
        width: 1.1rem;
        height: 0.7rem;
        border-radius: 2px;
        opacity: 0.35;
    }
}

.chart-wrapper {
    height: 260px;
    position: relative;
}
</style>
