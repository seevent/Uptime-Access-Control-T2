<template>
    <div ref="modal" class="modal fade" tabindex="-1">
        <div class="modal-dialog modal-lg modal-dialog-scrollable">
            <div class="modal-content">
                <div class="modal-header">
                    <h5 class="modal-title">
                        {{ $t("networkUptimeDialogTitle", { name: deviceName, ip: device ? device.ip : "" }) }}
                    </h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal" :aria-label="$t('Close')" />
                </div>
                <div class="modal-body">
                    <NetworkPeriodPicker
                        class="mb-3"
                        :model-value="modelValue"
                        @update:model-value="$emit('update:modelValue', $event)"
                    />

                    <p v-if="loading || historyLoading || pingLoading" class="small mb-2" role="status">
                        <span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>
                        {{ $t("networkUptimeLoading") }}
                    </p>
                    <p v-if="loading && !result" class="text-center my-3">{{ $t("networkUptimeLoading") }}</p>
                    <div v-else-if="error" class="alert alert-danger" role="alert">{{ error }}</div>

                    <div v-else-if="result" :class="{ 'is-stale': loading || historyLoading || pingLoading }">
                        <div class="row g-2 mb-3 text-center">
                            <div class="col-6 col-md">
                                <div class="stat border rounded p-2">
                                    <div class="small">{{ $t("networkUptimePercent") }}</div>
                                    <div class="fs-4">{{ percentText }}</div>
                                </div>
                            </div>
                            <div class="col-6 col-md">
                                <div class="stat border rounded p-2">
                                    <div class="small">{{ $t("networkUptimeUp") }}</div>
                                    <div class="fs-5 text-nowrap">{{ duration(result.upSeconds) }}</div>
                                </div>
                            </div>
                            <div class="col-6 col-md">
                                <div class="stat border rounded p-2">
                                    <div class="small">{{ $t("networkUptimeDown") }}</div>
                                    <div class="fs-5 text-nowrap">{{ duration(result.downSeconds) }}</div>
                                </div>
                            </div>
                            <div class="col-6 col-md">
                                <div class="stat border rounded p-2">
                                    <div class="small">{{ $t("networkUptimeMaintenance") }}</div>
                                    <div class="fs-5 text-nowrap">{{ duration(result.maintenanceSeconds) }}</div>
                                </div>
                            </div>
                            <div class="col-6 col-md">
                                <div class="stat border rounded p-2">
                                    <div class="small">{{ $t("networkUptimeNoData") }}</div>
                                    <div class="fs-5 text-nowrap">{{ duration(result.noDataSeconds) }}</div>
                                </div>
                            </div>
                        </div>

                        <p class="small mb-2">
                            {{ $t("networkUptimeDownCount", { count: result.downCount }) }}
                            <template v-if="result.dataSince">
                                ·
                                {{ $t("networkUptimeDataSince", { date: $root.datetime(result.dataSince) }) }}
                            </template>
                            <template v-if="result.monitorId !== null">
                                ·
                                <router-link :to="'/dashboard/' + result.monitorId" data-bs-dismiss="modal">
                                    {{ $t("networkUptimeOpenMonitor") }}
                                </router-link>
                            </template>
                        </p>

                        <!-- Ping -->
                        <h6 class="section-title">{{ $t("networkHistoryPingChartTitle") }}</h6>
                        <p v-if="pingError" class="small text-danger">{{ pingError }}</p>
                        <p v-else-if="!pingResult && pingLoading" class="small">{{ $t("networkUptimeLoading") }}</p>
                        <p v-else-if="pingResult && !pingSeries" class="my-3">
                            {{ $t("networkUptimePingEmpty") }}
                        </p>
                        <template v-else-if="pingSeries">
                            <div class="row g-2 mb-3 text-center">
                                <div class="col-6 col-md">
                                    <div class="stat border rounded p-2">
                                        <div class="small">{{ $t("networkPingLast") }}</div>
                                        <div class="fs-5 text-nowrap" :title="lastPingTitle">
                                            <span
                                                v-if="pingSeries.summary.last"
                                                class="ping-dot"
                                                :class="`ping-${lastPingLevel}`"
                                                aria-hidden="true"
                                            ></span>
                                            <span v-if="pingSeries.summary.last" class="visually-hidden">
                                                ({{ levelText(lastPingLevel) }})
                                            </span>
                                            {{ lastPingText }}
                                        </div>
                                        <div v-if="pingSeries.summary.last" class="small">{{ lastPingTitle }}</div>
                                    </div>
                                </div>
                                <div class="col-6 col-md">
                                    <div class="stat border rounded p-2">
                                        <div class="small">{{ $t("networkPingAverage") }}</div>
                                        <div class="fs-5 text-nowrap">{{ ping(pingSeries.summary.avg) }}</div>
                                    </div>
                                </div>
                                <div class="col-6 col-md">
                                    <div class="stat border rounded p-2">
                                        <div class="small">{{ $t("networkPingLowest") }}</div>
                                        <div class="fs-5 text-nowrap">{{ ping(pingSeries.summary.min) }}</div>
                                    </div>
                                </div>
                                <div class="col-6 col-md">
                                    <div class="stat border rounded p-2">
                                        <div class="small">{{ $t("networkPingHighest") }}</div>
                                        <div class="fs-5 text-nowrap">{{ ping(pingSeries.summary.max) }}</div>
                                    </div>
                                </div>
                            </div>
                            <NetworkPingChart
                                :series="[
                                    { deviceId: pingSeries.deviceId, label: deviceName, points: pingSeries.points },
                                ]"
                                :step-seconds="pingResult.stepSeconds"
                                :aria-label="$t('networkHistoryPingChartTitle')"
                            />
                            <p class="small mt-1">{{ resolutionText }}</p>
                        </template>

                        <!-- Status timeline and down chart -->
                        <h6 class="section-title">{{ $t("networkUptimeTimelineTitle") }}</h6>
                        <p v-if="historyError" class="small text-danger">{{ historyError }}</p>
                        <p v-else-if="!history && historyLoading" class="small">{{ $t("networkUptimeLoading") }}</p>
                        <template v-else-if="history">
                            <NetworkStatusTimeline
                                :rows="timelineRows"
                                :range-from="historyRange.from"
                                :range-to="historyRange.to"
                            />
                            <p v-if="history.segmentsTruncated" class="small mt-1">
                                {{ $t("networkUptimeTimelineTruncated") }}
                            </p>
                            <template v-if="downPeriods.length > 0">
                                <h6 class="section-title">{{ downBucketTitle }}</h6>
                                <NetworkBarChart
                                    :labels="downBuckets.buckets.map((b) => b.label)"
                                    :values="downBuckets.buckets.map((b) => b.count)"
                                    color="#dc3545"
                                    :value-label="$t('networkHistoryBarValueLabel')"
                                    :aria-label="downBucketTitle"
                                />
                            </template>
                        </template>

                        <h6 class="section-title">{{ $t("networkUptimePeriodsTitle") }}</h6>
                        <p v-if="result.downPeriods.length === 0" class="my-3">
                            {{ $t("networkUptimeNoDownPeriods") }}
                        </p>
                        <div v-else class="table-responsive">
                            <table class="table table-sm align-middle">
                                <thead>
                                    <tr>
                                        <th scope="col">{{ $t("networkUptimePeriodStart") }}</th>
                                        <th scope="col">{{ $t("networkUptimePeriodEnd") }}</th>
                                        <th scope="col">{{ $t("networkUptimePeriodDuration") }}</th>
                                        <th scope="col">{{ $t("networkUptimePeriodMessage") }}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <tr v-for="period in result.downPeriods" :key="period.start">
                                        <td class="text-nowrap">{{ $root.datetime(period.start) }}</td>
                                        <td class="text-nowrap">{{ $root.datetime(period.end) }}</td>
                                        <td class="text-nowrap">{{ duration(period.seconds) }}</td>
                                        <td class="period-message">{{ period.msg }}</td>
                                    </tr>
                                </tbody>
                            </table>
                            <p v-if="result.downPeriodsTruncated" class="small">
                                {{ $t("networkUptimeTruncated", { count: result.downPeriods.length }) }}
                            </p>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<script>
import { Modal } from "bootstrap";
import NetworkBarChart from "./NetworkBarChart.vue";
import NetworkPeriodPicker from "./NetworkPeriodPicker.vue";
import NetworkPingChart from "./NetworkPingChart.vue";
import NetworkStatusTimeline from "./NetworkStatusTimeline.vue";
import { bucketDown, segmentBars } from "../network-history-aggregate.js";
import { formatPing, pingLevel } from "../network-ping-format.js";
import { formatDuration, formatPercent, resolveRange } from "../network-uptime-format.js";

export default {
    components: {
        NetworkBarChart,
        NetworkPeriodPicker,
        NetworkPingChart,
        NetworkStatusTimeline,
    },

    props: {
        /** The device to show, from the inventory */
        device: {
            type: Object,
            default: null,
        },
        /** The chosen period, see NetworkPeriodPicker */
        modelValue: {
            type: Object,
            required: true,
        },
    },

    emits: ["update:modelValue"],

    data() {
        return {
            modal: null,
            shown: false,
            loading: false,
            result: null,
            error: null,
            seq: 0,

            // The status timeline and the ping line load next to the uptime; each has its own answer and error
            history: null,
            historyRange: { from: 0, to: 0 },
            historyError: null,
            historyLoading: false,
            historySeq: 0,
            pingResult: null,
            pingError: null,
            pingLoading: false,
            pingSeq: 0,
        };
    },

    computed: {
        deviceName() {
            return this.device ? this.device.label || this.device.hostname || this.device.ip : "";
        },

        units() {
            return {
                day: this.$t("networkUptimeUnitDay"),
                hour: this.$t("networkUptimeUnitHour"),
                minute: this.$t("networkUptimeUnitMinute"),
                second: this.$t("networkUptimeUnitSecond"),
            };
        },

        /**
         * The line of this device; null when the device has no successful check in the period.
         * @returns {object|null} The series of the ping answer
         */
        pingSeries() {
            const series = this.pingResult && this.pingResult.series[0];
            return series && series.summary.samples > 0 ? series : null;
        },

        lastPingLevel() {
            const last = this.pingSeries.summary.last;
            return last ? pingLevel(last.ping) : null;
        },

        lastPingText() {
            const last = this.pingSeries.summary.last;
            return last ? this.ping(last.ping) : "—";
        },

        lastPingTitle() {
            const last = this.pingSeries.summary.last;
            return last ? this.$root.datetimeFormat(last.time, "YYYY-MM-DD HH:mm:ss") : "";
        },

        resolutionText() {
            const key = { minute: "Minute", hour: "Hour", day: "Day" }[this.pingResult.resolution];
            return this.$t("networkHistoryResolution" + key);
        },

        timelineRows() {
            const { from, to } = this.historyRange;
            const bars = segmentBars(this.history.segments, from, to).map((b) => ({
                leftPercent: b.leftPercent,
                widthPercent: b.widthPercent,
                state: b.state,
                title: `${this.stateText(b.state)}: ${this.$root.datetimeFormat(b.start, "YYYY-MM-DD HH:mm")} - ${this.$root.datetimeFormat(b.end, "YYYY-MM-DD HH:mm")} (${this.duration((b.end - b.start) / 1000)})`,
            }));
            return [{ key: "status", label: this.deviceName, bars }];
        },

        downPeriods() {
            return this.history.segments.filter((s) => s.state === "down").map((s) => [s.start, s.end]);
        },

        downBuckets() {
            return bucketDown(this.downPeriods, this.historyRange.from, this.historyRange.to, this.$root.timezone);
        },

        downBucketTitle() {
            return this.downBuckets.unit === "hour"
                ? this.$t("networkHistoryBarTitleHour")
                : this.$t("networkHistoryBarTitleDay");
        },

        percentText() {
            return this.result.uptimePercent === null
                ? this.$t("networkUptimeNoData")
                : formatPercent(this.result.uptimePercent, this.$i18n.locale) + "%";
        },
    },

    watch: {
        modelValue: {
            deep: true,
            handler() {
                if (this.shown) {
                    this.load();
                }
            },
        },
    },

    mounted() {
        this.modal = new Modal(this.$refs.modal);
        this.$refs.modal.addEventListener("hidden.bs.modal", () => {
            this.shown = false;
            this.seq++;
            this.historySeq++;
            this.pingSeq++;
        });
    },

    beforeUnmount() {
        if (this.modal) {
            try {
                this.modal.hide();
            } catch (e) {
                console.warn("Modal hide failed:", e);
            }
        }
    },

    methods: {
        /**
         * Open the dialog and load the uptime of the device.
         * @returns {void}
         */
        show() {
            this.result = null;
            this.error = null;
            this.history = null;
            this.historyError = null;
            this.pingResult = null;
            this.pingError = null;
            this.shown = true;
            this.modal.show();
            this.load();
        },

        /**
         * Ask the server for the uptime. Only the newest request may change what is shown, so a slow answer for an
         * earlier period never replaces the answer for the current one.
         * @returns {void}
         */
        load() {
            if (!this.device) {
                return;
            }
            const seq = ++this.seq;
            const { from, to } = resolveRange(this.modelValue);
            this.loading = true;
            this.$root.getSocket().emit("getNetworkDeviceUptime", { id: this.device.id, from, to }, (res) => {
                if (seq !== this.seq) {
                    return;
                }
                this.loading = false;
                if (res.ok) {
                    this.result = res.uptime;
                    this.error = null;
                } else {
                    this.result = null;
                    this.error = res.msg;
                }
            });
            this.loadHistory(from, to);
            this.loadPing(from, to);
        },

        /**
         * Load the status segments of the device. A failure only shows a small note in its own part.
         * @param {string} fromIso Start of the period
         * @param {string} toIso End of the period
         * @returns {void}
         */
        loadHistory(fromIso, toIso) {
            const seq = ++this.historySeq;
            this.historyLoading = true;
            this.$root
                .getSocket()
                .emit("getNetworkDeviceHistory", { id: this.device.id, from: fromIso, to: toIso }, (res) => {
                    if (seq !== this.historySeq) {
                        return;
                    }
                    this.historyLoading = false;
                    if (res.ok) {
                        this.history = res.history;
                        this.historyRange = {
                            from: Date.parse(fromIso),
                            to: res.history.effectiveTo || Date.parse(toIso),
                        };
                        this.historyError = null;
                    } else {
                        this.history = null;
                        this.historyError = res.msg;
                    }
                });
        },

        /**
         * Load the ping line of the device. A failure only shows a small note in its own part.
         * @param {string} fromIso Start of the period
         * @param {string} toIso End of the period
         * @returns {void}
         */
        loadPing(fromIso, toIso) {
            const seq = ++this.pingSeq;
            this.pingLoading = true;
            this.$root
                .getSocket()
                .emit("getNetworkPingSeries", { ids: [this.device.id], from: fromIso, to: toIso }, (res) => {
                    if (seq !== this.pingSeq) {
                        return;
                    }
                    this.pingLoading = false;
                    if (res.ok) {
                        this.pingResult = res.ping;
                        this.pingError = null;
                    } else {
                        this.pingResult = null;
                        this.pingError = res.msg;
                    }
                });
        },

        ping(ms) {
            return formatPing(ms, this.$i18n.locale);
        },

        levelText(level) {
            return level ? this.$t("networkPingLevel" + level[0].toUpperCase() + level.slice(1)) : "";
        },

        stateText(state) {
            return (
                { up: this.$t("Up"), down: this.$t("networkHistoryLegendDown"), maintenance: this.$t("Maintenance") }[
                    state
                ] || this.$t("Pending")
            );
        },

        /**
         * @param {number} seconds Seconds
         * @returns {string} For example "2h 3j 5m 10d"
         */
        duration(seconds) {
            return formatDuration(seconds, this.units);
        },
    },
};
</script>

<style lang="scss" scoped>
.is-stale {
    opacity: 0.45;
    transition: opacity 0.15s;
}

.section-title {
    margin: 1.25rem 0 0.5rem;
    font-weight: 600;
}

.ping-dot {
    display: inline-block;
    width: 0.6rem;
    height: 0.6rem;
    border-radius: 50%;
    margin-right: 0.25rem;
}

.ping-good {
    background: #0ca30c;
}

.ping-fair {
    background: #fab219;
}

.ping-slow {
    background: #d03b3b;
}

.period-message {
    word-break: break-word;
    min-width: 12rem;
}
</style>
