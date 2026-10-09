<template>
    <div ref="modal" class="modal fade" tabindex="-1">
        <div class="modal-dialog modal-xl modal-dialog-scrollable">
            <div class="modal-content">
                <div class="modal-header">
                    <h5 class="modal-title">{{ modalTitle }}</h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal" :aria-label="$t('Close')" />
                </div>
                <div class="modal-body">
                    <div class="d-flex flex-wrap align-items-center gap-2 mb-3">
                        <NetworkPeriodPicker
                            :model-value="modelValue"
                            @update:model-value="$emit('update:modelValue', $event)"
                        />
                        <button
                            type="button"
                            class="btn btn-sm btn-normal ms-auto"
                            :disabled="csvDisabled"
                            @click="exportCsv"
                        >
                            {{ $t("networkUptimeExportCsv") }}
                        </button>
                    </div>

                    <p v-if="busy" class="small mb-2" role="status">
                        <span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>
                        {{ $t("networkUptimeLoading") }}
                    </p>

                    <ul class="nav nav-tabs mb-3" role="tablist">
                        <li class="nav-item" role="presentation">
                            <button
                                type="button"
                                class="nav-link"
                                :class="{ active: tab === 'down' }"
                                role="tab"
                                :aria-selected="tab === 'down'"
                                @click="selectTab('down')"
                            >
                                {{ $t("networkHistoryTabDown") }}
                            </button>
                        </li>
                        <li class="nav-item" role="presentation">
                            <button
                                type="button"
                                class="nav-link"
                                :class="{ active: tab === 'ping' }"
                                role="tab"
                                :aria-selected="tab === 'ping'"
                                @click="selectTab('ping')"
                            >
                                {{ $t("networkHistoryTabPing") }}
                            </button>
                        </li>
                    </ul>

                    <!-- Down -->
                    <div v-if="tab === 'down'" role="tabpanel" :class="{ 'is-stale': downLoading }">
                        <p v-if="downLoading && !down" class="text-center my-3">{{ $t("networkUptimeLoading") }}</p>
                        <div v-else-if="downError" class="alert alert-danger" role="alert">{{ downError }}</div>
                        <template v-else-if="down">
                            <p v-if="downSummary.devices === 0" class="my-3">{{ $t("networkHistoryDownEmpty") }}</p>
                            <template v-else>
                                <p class="mb-3">
                                    {{
                                        $t("networkHistoryDownSummary", {
                                            devices: downSummary.devices,
                                            count: downSummary.count,
                                            duration: duration(downSummary.seconds),
                                        })
                                    }}
                                </p>
                                <p v-if="downSummary.truncated" class="small text-warning-emphasis">
                                    {{ $t("networkHistoryDownTruncated") }}
                                </p>

                                <h6 class="section-title">{{ $t("networkHistoryRankTitle") }}</h6>
                                <div class="btn-group btn-group-sm mb-2" role="group">
                                    <button
                                        type="button"
                                        class="btn"
                                        :class="rankBy === 'count' ? 'btn-primary' : 'btn-outline-primary'"
                                        @click="rankBy = 'count'"
                                    >
                                        {{ $t("networkHistoryRankByCount") }}
                                    </button>
                                    <button
                                        type="button"
                                        class="btn"
                                        :class="rankBy === 'seconds' ? 'btn-primary' : 'btn-outline-primary'"
                                        @click="rankBy = 'seconds'"
                                    >
                                        {{ $t("networkHistoryRankBySeconds") }}
                                    </button>
                                </div>
                                <NetworkRankList :rows="downRankRows" @open="openDevice" />

                                <h6 class="section-title">{{ downBucketTitle }}</h6>
                                <NetworkBarChart
                                    :labels="downBuckets.buckets.map((b) => b.label)"
                                    :values="downBuckets.buckets.map((b) => b.count)"
                                    color="#dc3545"
                                    :value-label="$t('networkHistoryBarValueLabel')"
                                    :aria-label="downBucketTitle"
                                />

                                <h6 class="section-title">{{ $t("networkHistoryTimelineTitle") }}</h6>
                                <NetworkStatusTimeline
                                    :rows="downTimelineRows"
                                    :range-from="down.from"
                                    :range-to="down.to"
                                />
                                <p v-if="downTimelineMore > 0" class="small mt-1">
                                    {{
                                        $t("networkHistoryTimelineMore", {
                                            count: downTimelineMore,
                                            limit: TIMELINE_LIMIT,
                                        })
                                    }}
                                </p>

                                <h6 class="section-title">{{ $t("networkHistoryHeatmapTitle") }}</h6>
                                <NetworkHeatmap v-if="showHeatmap" :cells="heatmap.cells" :max="heatmap.max" />
                                <p v-else class="small">{{ $t("networkHistoryHeatmapShort") }}</p>
                            </template>
                        </template>
                    </div>

                    <!-- Ping -->
                    <div v-else role="tabpanel" :class="{ 'is-stale': pingLoading || seriesLoading }">
                        <p v-if="pingLoading && !pingSummary" class="text-center my-3">
                            {{ $t("networkUptimeLoading") }}
                        </p>
                        <div v-else-if="pingError" class="alert alert-danger" role="alert">{{ pingError }}</div>
                        <template v-else-if="pingSummary">
                            <p v-if="pingItems.length === 0" class="my-3">{{ $t("networkHistoryPingEmpty") }}</p>
                            <template v-else>
                                <h6 class="section-title">{{ $t("networkHistoryPingRankTitle") }}</h6>
                                <div class="btn-group btn-group-sm mb-2" role="group">
                                    <button
                                        v-for="metric in pingMetrics"
                                        :key="metric"
                                        type="button"
                                        class="btn"
                                        :class="pingMetric === metric ? 'btn-primary' : 'btn-outline-primary'"
                                        @click="pingMetric = metric"
                                    >
                                        {{ $t("networkHistoryPingMetric_" + metric) }}
                                    </button>
                                </div>
                                <p class="small mb-1">
                                    {{ $t("networkHistoryPingSelectHint", { max: MAX_SERIES }) }}
                                </p>
                                <NetworkRankList
                                    :rows="pingRankRows"
                                    selectable
                                    :selected-ids="selectedIds"
                                    :max-selected="MAX_SERIES"
                                    @open="openDevice"
                                    @update:selected-ids="onSelection"
                                />

                                <h6 class="section-title">{{ $t("networkHistoryPingChartTitle") }}</h6>
                                <p v-if="seriesLoading && !seriesResult" class="text-center my-3">
                                    {{ $t("networkUptimeLoading") }}
                                </p>
                                <div v-else-if="seriesError" class="alert alert-danger" role="alert">
                                    {{ seriesError }}
                                </div>
                                <p v-else-if="selectedIds.length === 0" class="my-3">
                                    {{ $t("networkHistoryPingNoneSelected") }}
                                </p>
                                <template v-else-if="seriesResult">
                                    <NetworkPingChart
                                        :series="chartSeries"
                                        :step-seconds="seriesResult.stepSeconds"
                                        :aria-label="$t('networkHistoryPingChartTitle')"
                                    />
                                    <p class="small mt-1">{{ resolutionText }}</p>
                                    <div class="table-responsive">
                                        <table class="table table-sm align-middle">
                                            <thead>
                                                <tr>
                                                    <th scope="col">{{ $t("networkScanColumnLabel") }}</th>
                                                    <th scope="col">{{ $t("networkPingLast") }}</th>
                                                    <th scope="col">{{ $t("networkPingAverage") }}</th>
                                                    <th scope="col">{{ $t("networkPingLowest") }}</th>
                                                    <th scope="col">{{ $t("networkPingHighest") }}</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                <tr v-for="s in chartSeries" :key="s.deviceId">
                                                    <td>{{ s.label }}</td>
                                                    <td class="text-nowrap">
                                                        {{ ping(s.summary.last ? s.summary.last.ping : null) }}
                                                    </td>
                                                    <td class="text-nowrap">{{ ping(s.summary.avg) }}</td>
                                                    <td class="text-nowrap">{{ ping(s.summary.min) }}</td>
                                                    <td class="text-nowrap">{{ ping(s.summary.max) }}</td>
                                                </tr>
                                            </tbody>
                                        </table>
                                    </div>
                                </template>
                            </template>
                        </template>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<script>
import { Modal } from "bootstrap";
import { useToast } from "vue-toastification";
import NetworkBarChart from "./NetworkBarChart.vue";
import NetworkHeatmap from "./NetworkHeatmap.vue";
import NetworkPeriodPicker from "./NetworkPeriodPicker.vue";
import NetworkPingChart from "./NetworkPingChart.vue";
import NetworkRankList from "./NetworkRankList.vue";
import NetworkStatusTimeline from "./NetworkStatusTimeline.vue";
import { bucketDown, heatmapGrid, rankDevices, timelineRows } from "../network-history-aggregate.js";
import { categoryNames } from "../network-device-filter.js";
import { buildDownEventsCsv, buildPingCsv } from "../network-history-csv.js";
import { defaultSeriesIds, formatPing, pingLevel, rankPing } from "../network-ping-format.js";
import { csvFileName, formatDuration, resolveRange } from "../network-uptime-format.js";

const MAX_SERIES = 5;
const TIMELINE_LIMIT = 30;
const HEATMAP_MIN_DAYS = 3;

export default {
    components: {
        NetworkBarChart,
        NetworkHeatmap,
        NetworkPeriodPicker,
        NetworkPingChart,
        NetworkRankList,
        NetworkStatusTimeline,
    },

    props: {
        /** The inventory, to give every device its name */
        devices: {
            type: Array,
            default: () => [],
        },
        /** The categories, to write the category of a device in the CSV files */
        categories: {
            type: Array,
            default: () => [],
        },
        /** True when `devices` is only the part of the inventory that matches the category filter */
        filterActive: {
            type: Boolean,
            default: false,
        },
        /** Name of the filter, for the title (empty without a filter) */
        filterLabel: {
            type: String,
            default: "",
        },
        /** The chosen period, see NetworkPeriodPicker */
        modelValue: {
            type: Object,
            required: true,
        },
    },

    emits: ["update:modelValue", "open-device"],

    data() {
        return {
            MAX_SERIES,
            TIMELINE_LIMIT,
            modal: null,
            shown: false,
            tab: "down",
            // Which tabs must be loaded again because the period changed
            staleDown: true,
            stalePing: true,

            downSeq: 0,
            downLoading: false,
            down: null,
            downError: null,
            rankBy: "count",

            pingSeq: 0,
            pingLoading: false,
            pingSummary: null,
            pingError: null,
            pingMetric: "avg",
            pingMetrics: ["avg", "max", "spread"],

            csvSeq: 0,
            csvBusy: false,

            // The period each tab was loaded for, so a CSV file covers what is on screen
            downRange: null,
            pingRange: null,

            seriesSeq: 0,
            seriesLoading: false,
            seriesResult: null,
            seriesError: null,
            selectedIds: [],
            // Colour slot of every selected device, so a colour stays with its device
            slots: {},
        };
    },

    computed: {
        // True while an answer is on its way; what is on screen may still be of the previous period
        busy() {
            return this.tab === "down" ? this.downLoading : this.pingLoading || this.seriesLoading;
        },

        modalTitle() {
            return this.filterLabel
                ? this.$t("networkHistoryTitleFiltered", { filter: this.filterLabel })
                : this.$t("networkHistoryDialogTitle");
        },

        /**
         * @returns {number[]} Ids of the devices in the dialog that have a monitor
         */
        monitoredIds() {
            return this.devices.filter((d) => d.monitorId !== null).map((d) => d.id);
        },

        /**
         * The server answers for all devices unless it is given the ids; with a filter on it must be given them.
         * @returns {{deviceIds?: number[]}} Part of the payload of a query
         */
        deviceIdsPayload() {
            return this.filterActive ? { deviceIds: this.monitoredIds } : {};
        },

        /**
         * Changes when the devices the dialog asks for change (a different filter, or a device of the filter
         * monitored or no longer monitored). Unfiltered it stays "all".
         * @returns {string} Key
         */
        filterKey() {
            return this.filterActive ? [...this.monitoredIds].sort((a, b) => a - b).join(",") : "all";
        },

        csvDisabled() {
            if (this.busy || this.csvBusy) {
                return true;
            }
            if (this.tab === "down") {
                return !this.down || this.downSummary.devices === 0;
            }
            return !this.pingSummary || this.monitoredIds.length === 0;
        },

        deviceById() {
            return Object.fromEntries(this.devices.map((d) => [d.id, d]));
        },

        units() {
            return {
                day: this.$t("networkUptimeUnitDay"),
                hour: this.$t("networkUptimeUnitHour"),
                minute: this.$t("networkUptimeUnitMinute"),
                second: this.$t("networkUptimeUnitSecond"),
            };
        },

        downSummary() {
            const withDown = this.down.history.devices.filter((d) => d.downCount > 0);
            return {
                devices: withDown.length,
                count: withDown.reduce((sum, d) => sum + d.downCount, 0),
                seconds: withDown.reduce((sum, d) => sum + d.downSeconds, 0),
                truncated: withDown.some((d) => d.periodsTruncated),
            };
        },

        downRankRows() {
            const by = this.rankBy;
            const ranked = rankDevices(this.down.history.devices, by, 10);
            const key = by === "count" ? "downCount" : "downSeconds";
            const top = ranked.length > 0 ? ranked[0][key] : 0;
            return ranked.map((d) => ({
                id: d.deviceId,
                label: this.nameOf(d.deviceId),
                valueText: this.$t("networkHistoryRankValue", {
                    count: d.downCount,
                    duration: this.duration(d.downSeconds),
                }),
                fraction: top > 0 ? d[key] / top : 0,
            }));
        },

        allPeriods() {
            return this.down.history.devices.flatMap((d) => d.periods);
        },

        downBuckets() {
            return bucketDown(this.allPeriods, this.down.from, this.down.to, this.$root.timezone);
        },

        downBucketTitle() {
            return this.downBuckets.unit === "hour"
                ? this.$t("networkHistoryBarTitleHour")
                : this.$t("networkHistoryBarTitleDay");
        },

        downTimelineRows() {
            const rows = timelineRows(this.down.history.devices, this.down.from, this.down.to, TIMELINE_LIMIT);
            return rows.map((row) => ({
                key: row.deviceId,
                label: this.nameOf(row.deviceId),
                bars: row.bars.map((b) => ({
                    leftPercent: b.leftPercent,
                    widthPercent: b.widthPercent,
                    title: `${this.$root.datetimeFormat(b.start, "YYYY-MM-DD HH:mm")} - ${this.$root.datetimeFormat(b.end, "YYYY-MM-DD HH:mm")} (${this.duration((b.end - b.start) / 1000)})`,
                })),
            }));
        },

        downTimelineMore() {
            return Math.max(0, this.downSummary.devices - TIMELINE_LIMIT);
        },

        showHeatmap() {
            return this.down.to - this.down.from >= HEATMAP_MIN_DAYS * 86400 * 1000;
        },

        heatmap() {
            return heatmapGrid(this.allPeriods, this.down.from, this.down.to, this.$root.timezone);
        },

        pingItems() {
            return this.pingSummary.items.filter((item) => item.samples > 0);
        },

        pingRankRows() {
            const metric = this.pingMetric;
            const value = (item) => (metric === "spread" ? item.max - item.min : item[metric]);
            const ranked = rankPing(this.pingItems, metric, 10);
            const top = ranked.length > 0 ? value(ranked[0]) : 0;
            // A device that is picked stays in the list, so it can always be unticked
            const missing = this.pingItems.filter(
                (item) => this.selectedIds.includes(item.deviceId) && !ranked.some((r) => r.deviceId === item.deviceId)
            );
            return [...ranked, ...missing].map((item) => ({
                id: item.deviceId,
                label: this.nameOf(item.deviceId),
                valueText: formatPing(value(item), this.$i18n.locale),
                fraction: top > 0 ? value(item) / top : 0,
                level: metric === "spread" ? null : pingLevel(value(item)),
            }));
        },

        chartSeries() {
            return this.seriesResult.series
                .filter((s) => this.selectedIds.includes(s.deviceId))
                .map((s) => ({
                    deviceId: s.deviceId,
                    label: this.nameOf(s.deviceId),
                    colorIndex: this.slots[s.deviceId],
                    points: s.points,
                    summary: s.summary,
                }));
        },

        resolutionText() {
            const key = { minute: "Minute", hour: "Hour", day: "Day" }[this.seriesResult.resolution];
            return this.$t("networkHistoryResolution" + key);
        },
    },

    watch: {
        // The filter changed while the dialog is open (for example its category was deleted on another screen)
        filterKey() {
            if (!this.shown) {
                return;
            }
            this.down = null;
            this.downError = null;
            this.pingSummary = null;
            this.pingError = null;
            this.seriesResult = null;
            this.seriesError = null;
            this.selectedIds = [];
            this.slots = {};
            this.staleDown = true;
            this.stalePing = true;
            this.loadTab();
        },

        modelValue: {
            deep: true,
            handler() {
                if (!this.shown) {
                    return;
                }
                this.staleDown = true;
                this.stalePing = true;
                this.loadTab();
            },
        },
    },

    mounted() {
        this.modal = new Modal(this.$refs.modal);
        this.$refs.modal.addEventListener("hidden.bs.modal", () => {
            this.shown = false;
            // Answers that arrive after the dialog was closed are ignored
            this.downSeq++;
            this.pingSeq++;
            this.seriesSeq++;
            this.csvSeq++;
            this.csvBusy = false;
            this.downLoading = false;
            this.pingLoading = false;
            this.seriesLoading = false;
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
         * Open the dialog on the Down tab.
         * @returns {void}
         */
        show() {
            this.down = null;
            this.downError = null;
            this.pingSummary = null;
            this.pingError = null;
            this.seriesResult = null;
            this.seriesError = null;
            this.selectedIds = [];
            this.slots = {};
            this.staleDown = true;
            this.stalePing = true;
            this.tab = "down";
            this.shown = true;
            this.modal.show();
            this.loadTab();
        },

        selectTab(tab) {
            this.tab = tab;
            this.loadTab();
        },

        /**
         * Load the tab on screen when it has not been loaded for the period yet.
         * @returns {void}
         */
        loadTab() {
            if (this.tab === "down" && this.staleDown) {
                this.loadDown();
            } else if (this.tab === "ping" && this.stalePing) {
                this.loadPing();
            }
        },

        /**
         * The period as milliseconds.
         * @returns {{from: number, to: number, fromIso: string, toIso: string}} The range
         */
        range() {
            const { from, to } = resolveRange(this.modelValue);
            return { from: Date.parse(from), to: Date.parse(to), fromIso: from, toIso: to };
        },

        /**
         * Load the down history of all devices. Only the newest request may change what is shown.
         * @returns {void}
         */
        loadDown() {
            const seq = ++this.downSeq;
            const { from, to, fromIso, toIso } = this.range();
            this.downRange = { fromIso, toIso };
            this.staleDown = false;
            this.downLoading = true;
            this.$root
                .getSocket()
                .emit("getNetworkDownHistory", { from: fromIso, to: toIso, ...this.deviceIdsPayload }, (res) => {
                    if (seq !== this.downSeq) {
                        return;
                    }
                    this.downLoading = false;
                    if (res.ok) {
                        // The server may have cut the end of the range to "now"
                        this.down = { history: res.history, from, to: res.history.effectiveTo || to };
                        this.downError = null;
                    } else {
                        this.down = null;
                        this.downError = res.msg;
                        this.staleDown = true;
                    }
                });
        },

        /**
         * Load the ping summary of all devices, then the lines of the devices that are picked.
         * @returns {void}
         */
        loadPing() {
            const seq = ++this.pingSeq;
            const { fromIso, toIso } = this.range();
            this.pingRange = { fromIso, toIso };
            this.stalePing = false;
            this.pingLoading = true;
            this.$root
                .getSocket()
                .emit("getNetworkPingSummary", { from: fromIso, to: toIso, ...this.deviceIdsPayload }, (res) => {
                    if (seq !== this.pingSeq) {
                        return;
                    }
                    this.pingLoading = false;
                    if (res.ok) {
                        this.pingSummary = res.summary;
                        this.pingError = null;
                        // Keep the picked devices that still have a ping; pick the three slowest when none is left
                        const withPing = new Set(this.pingItems.map((item) => item.deviceId));
                        let ids = this.selectedIds.filter((id) => withPing.has(id));
                        if (ids.length === 0) {
                            ids = defaultSeriesIds(this.pingItems, 3);
                        }
                        this.setSelection(ids);
                        this.loadSeries();
                    } else {
                        this.pingSummary = null;
                        this.pingError = res.msg;
                        this.stalePing = true;
                    }
                });
        },

        /**
         * Load the ping lines of the picked devices.
         * @returns {void}
         */
        loadSeries() {
            const seq = ++this.seriesSeq;
            if (this.selectedIds.length === 0) {
                this.seriesLoading = false;
                this.seriesResult = null;
                return;
            }
            const { fromIso, toIso } = this.range();
            this.seriesLoading = true;
            const payload = { ids: [...this.selectedIds], from: fromIso, to: toIso };
            this.$root.getSocket().emit("getNetworkPingSeries", payload, (res) => {
                if (seq !== this.seriesSeq) {
                    return;
                }
                this.seriesLoading = false;
                if (res.ok) {
                    this.seriesResult = res.ping;
                    this.seriesError = null;
                } else {
                    this.seriesResult = null;
                    this.seriesError = res.msg;
                }
            });
        },

        /**
         * The picked devices changed by hand in the list.
         * @param {number[]} ids Device ids
         * @returns {void}
         */
        onSelection(ids) {
            this.setSelection(ids);
            this.loadSeries();
        },

        /**
         * Pick devices; a device that stays picked keeps its colour, a new one gets the lowest free colour.
         * @param {number[]} ids Device ids
         * @returns {void}
         */
        setSelection(ids) {
            const slots = {};
            for (const id of ids) {
                if (this.slots[id] !== undefined) {
                    slots[id] = this.slots[id];
                }
            }
            const taken = new Set(Object.values(slots));
            for (const id of ids) {
                if (slots[id] === undefined) {
                    let slot = 0;
                    while (taken.has(slot)) {
                        slot++;
                    }
                    slots[id] = slot;
                    taken.add(slot);
                }
            }
            this.slots = slots;
            this.selectedIds = ids;
        },

        /**
         * Close this dialog and ask the page to open the detail of the device.
         * @param {number} id Device id
         * @returns {void}
         */
        openDevice(id) {
            const device = this.deviceById[id];
            if (!device) {
                return;
            }
            this.$refs.modal.addEventListener("hidden.bs.modal", () => this.$emit("open-device", device), {
                once: true,
            });
            this.modal.hide();
        },

        /**
         * Name, address and category of a device, for the CSV files.
         * @param {number} id Device id
         * @returns {{name: string, ip: string, category: string, subcategory: string}} The details
         */
        deviceInfo(id) {
            const device = this.deviceById[id];
            const names = device ? categoryNames(device, this.categories) : { category: "", subcategory: "" };
            return { name: this.nameOf(id), ip: device ? device.ip : "", ...names };
        },

        /**
         * Download the tab on screen as a CSV file: the down events, or the ping of every device.
         * @returns {void}
         */
        exportCsv() {
            if (this.csvDisabled) {
                return;
            }
            const info = (id) => this.deviceInfo(id);
            if (this.tab === "ping") {
                const { fromIso, toIso } = this.pingRange;
                // The summary has every device that was asked for, also the ones without samples
                const devices = this.pingSummary.items.map((item) => ({ id: item.deviceId }));
                const headers = [
                    this.$t("networkCsvDevice"),
                    this.$t("networkCsvIp"),
                    this.$t("networkScanColumnCategory"),
                    this.$t("networkScanColumnSubcategory"),
                    this.$t("networkCsvPingAvg"),
                    this.$t("networkCsvPingMin"),
                    this.$t("networkCsvPingMax"),
                    this.$t("networkCsvPingSpread"),
                    this.$t("networkCsvPingSamples"),
                ];
                const text = buildPingCsv({ headers, devices, items: this.pingSummary.items, info });
                this.download(text, csvFileName(fromIso, toIso, "ping"));
                return;
            }

            const { fromIso, toIso } = this.downRange;
            const seq = ++this.csvSeq;
            this.csvBusy = true;
            this.$root
                .getSocket()
                .emit("getNetworkDownEvents", { from: fromIso, to: toIso, ...this.deviceIdsPayload }, (res) => {
                    if (seq !== this.csvSeq) {
                        return;
                    }
                    this.csvBusy = false;
                    if (!res.ok) {
                        this.$root.toastRes(res);
                        return;
                    }
                    if (res.truncated) {
                        useToast().warning(this.$t("networkHistoryCsvTruncated"));
                    }
                    const headers = [
                        this.$t("networkCsvDevice"),
                        this.$t("networkCsvIp"),
                        this.$t("networkScanColumnCategory"),
                        this.$t("networkScanColumnSubcategory"),
                        this.$t("networkUptimeCsvStart"),
                        this.$t("networkUptimeCsvEnd"),
                        this.$t("networkCsvDurationSeconds"),
                        this.$t("networkCsvOngoing"),
                        this.$t("networkCsvMessage"),
                    ];
                    const text = buildDownEventsCsv({
                        headers,
                        events: res.events,
                        effectiveTo: res.effectiveTo,
                        info,
                        formatTime: (ms) => this.$root.datetimeFormat(ms, "YYYY-MM-DD HH:mm:ss"),
                        yes: this.$t("networkCsvYes"),
                        no: this.$t("networkCsvNo"),
                    });
                    this.download(text, csvFileName(fromIso, new Date(res.effectiveTo).toISOString(), "down"));
                });
        },

        /**
         * Hand a text to the browser as a file to save.
         * @param {string} text File content
         * @param {string} fileName File name
         * @returns {void}
         */
        download(text, fileName) {
            const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = fileName;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
        },

        nameOf(id) {
            const device = this.deviceById[id];
            return device ? device.label || device.hostname || device.ip : `#${id}`;
        },

        duration(seconds) {
            return formatDuration(seconds, this.units, 2);
        },

        ping(ms) {
            return formatPing(ms, this.$i18n.locale);
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
    margin: 1.5rem 0 0.5rem;
    font-weight: 600;

    &:first-of-type {
        margin-top: 0.5rem;
    }
}
</style>
