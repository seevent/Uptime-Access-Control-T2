<template>
    <div class="status-timeline">
        <ul class="legend" :aria-label="$t('networkHistoryLegend')">
            <li v-for="item in legend" :key="item.key">
                <span class="swatch" :class="item.key"></span>
                {{ item.text }}
            </li>
        </ul>
        <div class="tl-scroll">
            <div class="tl-grid">
                <div v-for="row in rows" :key="row.key" class="tl-row">
                    <div class="tl-label" :title="row.label">{{ row.label }}</div>
                    <div class="tl-track" role="img" :aria-label="`${row.label}: ${barCountText(row)}`">
                        <span
                            v-for="(bar, index) in row.bars"
                            :key="index"
                            class="tl-bar"
                            :class="`state-${bar.state || 'down'}`"
                            :style="{ left: `${bar.leftPercent}%`, width: `${bar.widthPercent}%` }"
                            :title="bar.title"
                        ></span>
                    </div>
                </div>
                <div class="tl-row tl-axis">
                    <div class="tl-label"></div>
                    <div class="tl-axis-labels">
                        <span>{{ axisText(rangeFrom) }}</span>
                        <span>{{ axisText((rangeFrom + rangeTo) / 2) }}</span>
                        <span>{{ axisText(rangeTo) }}</span>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<script lang="js">
export default {
    props: {
        /** Rows: {key, label, bars: {leftPercent, widthPercent, state?, title}[]} */
        rows: {
            type: Array,
            default: () => [],
        },
        /** Start of the range (ms) */
        rangeFrom: {
            type: Number,
            default: 0,
        },
        /** End of the range (ms) */
        rangeTo: {
            type: Number,
            default: 0,
        },
    },
    computed: {
        // Bars with a state come from a status timeline of one device; bars without one are down periods only
        hasStates() {
            return this.rows.some((row) => row.bars.some((bar) => bar.state));
        },

        legend() {
            if (this.hasStates) {
                return [
                    { key: "state-up", text: this.$t("Up") },
                    { key: "state-down", text: this.$t("networkHistoryLegendDown") },
                    { key: "state-maintenance", text: this.$t("Maintenance") },
                    { key: "state-pending", text: this.$t("Pending") },
                    { key: "state-nodata", text: this.$t("networkHistoryLegendNoData") },
                ];
            }
            return [
                { key: "state-down", text: this.$t("networkHistoryLegendDown") },
                { key: "state-nodata", text: this.$t("networkHistoryLegendNotDown") },
            ];
        },

        spanMs() {
            return this.rangeTo - this.rangeFrom;
        },
    },
    methods: {
        axisText(value) {
            // Short ranges show the clock, long ranges show the date as well
            const format = this.spanMs <= 48 * 3600 * 1000 ? "HH:mm" : "MM-DD HH:mm";
            return this.$root.datetimeFormat(value, format);
        },

        barCountText(row) {
            return this.$t("networkHistoryTimelineBars", { count: row.bars.length });
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
    width: 0.85rem;
    height: 0.85rem;
    border-radius: 3px;
    vertical-align: -0.1rem;
    margin-right: 0.25rem;
}

.state-up {
    background: $primary;
}

.state-down {
    background: $danger;
}

.state-maintenance {
    background: $maintenance;
}

.state-pending {
    background: $warning;
}

.state-nodata {
    background: #d5dae0;
}

.dark .state-nodata {
    background: #3a4558;
}

.tl-scroll {
    overflow-x: auto;
}

.tl-grid {
    min-width: 420px;
}

.tl-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 4px;
}

.tl-label {
    flex: 0 0 11rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.9rem;
}

.tl-track {
    position: relative;
    flex: 1 1 auto;
    height: 18px;
    border-radius: 4px;
    background: #d5dae0;
    overflow: hidden;
}

.dark .tl-track {
    background: #2a3342;
}

.tl-bar {
    position: absolute;
    top: 0;
    bottom: 0;
    // A thin gap between neighbours so two runs never merge into one
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.35);
}

.dark .tl-bar {
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35);
}

.tl-axis-labels {
    flex: 1 1 auto;
    display: flex;
    justify-content: space-between;
    font-size: 0.8rem;
    color: $secondary-text;
}

@media (max-width: 575px) {
    // On a phone the name goes above its track, so it can be read in full
    .tl-grid {
        min-width: 0;
    }

    .tl-row {
        flex-direction: column;
        align-items: stretch;
        gap: 2px;
        margin-bottom: 8px;
    }

    .tl-label {
        flex-basis: auto;
    }

    .tl-axis .tl-label {
        display: none;
    }
}
</style>
