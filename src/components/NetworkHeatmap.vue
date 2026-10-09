<template>
    <div class="heatmap">
        <div class="hm-scroll">
            <div class="hm-grid" role="img" :aria-label="$t('networkHistoryHeatmapAria')">
                <div class="hm-corner"></div>
                <div v-for="hour in 24" :key="`h${hour}`" class="hm-hour">
                    {{ (hour - 1) % 3 === 0 ? String(hour - 1).padStart(2, "0") : "" }}
                </div>
                <template v-for="(row, day) in cells" :key="`d${day}`">
                    <div class="hm-day">{{ dayName(day) }}</div>
                    <div
                        v-for="(value, hour) in row"
                        :key="`c${day}-${hour}`"
                        class="hm-cell"
                        :class="{ empty: value === 0 }"
                        :style="cellStyle(value)"
                        :title="cellTitle(day, hour, value)"
                    ></div>
                </template>
            </div>
        </div>
        <div class="hm-legend">
            <span>{{ $t("networkHistoryHeatmapLess") }}</span>
            <span v-for="step in steps" :key="step" class="hm-step" :style="stepStyle(step)"></span>
            <span>{{ $t("networkHistoryHeatmapMore") }} ({{ durationText(max) }})</span>
        </div>
    </div>
</template>

<script lang="js">
import { formatDuration } from "../network-uptime-format.js";

export default {
    props: {
        /** 7 rows (Monday first) of 24 numbers: seconds of down time in that hour of that weekday */
        cells: {
            type: Array,
            default: () => [],
        },
        /** The largest number in cells (seconds) */
        max: {
            type: Number,
            default: 0,
        },
    },
    data() {
        return {
            steps: [0.25, 0.5, 0.75, 1],
        };
    },
    methods: {
        dayName(day) {
            // 2026-01-05 is a Monday
            const date = new Date(Date.UTC(2026, 0, 5 + day));
            return new Intl.DateTimeFormat(this.$i18n.locale, { weekday: "short", timeZone: "UTC" }).format(date);
        },

        cellStyle(value) {
            if (value <= 0 || this.max <= 0) {
                return {};
            }
            return this.stepStyle(value / this.max);
        },

        stepStyle(ratio) {
            // One hue (the Kuma red for down), darker means more
            return { background: `rgba(220, 53, 69, ${(0.2 + 0.8 * ratio).toFixed(2)})` };
        },

        cellTitle(day, hour, value) {
            return this.$t("networkHistoryHeatmapCell", {
                day: this.dayName(day),
                hour: String(hour).padStart(2, "0"),
                duration: this.durationText(value),
            });
        },

        durationText(seconds) {
            return formatDuration(
                seconds,
                {
                    day: this.$t("networkUptimeUnitDay"),
                    hour: this.$t("networkUptimeUnitHour"),
                    minute: this.$t("networkUptimeUnitMinute"),
                    second: this.$t("networkUptimeUnitSecond"),
                },
                2
            );
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../assets/vars.scss";

.hm-scroll {
    overflow-x: auto;
}

.hm-grid {
    display: grid;
    grid-template-columns: 2.5rem repeat(24, minmax(14px, 1fr));
    gap: 2px;
    min-width: 440px;
}

.hm-hour,
.hm-day {
    font-size: 0.75rem;
    color: $secondary-text;
    line-height: 1.2;
}

.hm-hour {
    text-align: left;
    white-space: nowrap;
}

.hm-day {
    display: flex;
    align-items: center;
}

.hm-cell {
    height: 20px;
    border-radius: 3px;

    &.empty {
        background: rgba(128, 128, 128, 0.15);
    }
}

.hm-legend {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin-top: 0.5rem;
    font-size: 0.8rem;
    color: $secondary-text;
}

.hm-step {
    display: inline-block;
    width: 1.25rem;
    height: 0.85rem;
    border-radius: 3px;
}
</style>
