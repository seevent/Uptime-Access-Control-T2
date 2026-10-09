<template>
    <div class="wallboard" :class="'wb-state-' + board.state">
        <Login v-if="!$root.loggedIn && $root.allowLoginDialog" />

        <template v-else-if="$root.loggedIn">
            <header class="wb-header">
                <div class="wb-title">Uptime Access Control T2</div>
                <div class="wb-clock" aria-hidden="true">
                    <span class="wb-time">{{ clockTime }}</span>
                    <span class="wb-date">{{ clockDate }}</span>
                </div>
                <div class="wb-tools">
                    <button
                        type="button"
                        class="wb-tool"
                        :aria-pressed="sound"
                        :title="sound ? $t('wallboardSoundOff') : $t('wallboardSoundOn')"
                        @click="toggleSound"
                    >
                        <font-awesome-icon :icon="sound ? 'volume-up' : 'volume-mute'" />
                        <span class="visually-hidden">
                            {{ sound ? $t("wallboardSoundOff") : $t("wallboardSoundOn") }}
                        </span>
                    </button>
                    <button type="button" class="wb-tool" :title="$t('wallboardFullscreen')" @click="toggleFullscreen">
                        <font-awesome-icon icon="expand" />
                        <span class="visually-hidden">{{ $t("wallboardFullscreen") }}</span>
                    </button>
                    <router-link to="/network-scan" class="wb-tool" :title="$t('wallboardExit')">
                        <font-awesome-icon icon="times" />
                        <span class="visually-hidden">{{ $t("wallboardExit") }}</span>
                    </router-link>
                </div>
            </header>

            <div v-if="!$root.socket.connected" class="wb-offline" role="alert">
                {{ $t("wallboardOffline") }}
            </div>

            <div class="wb-banner" role="status" aria-live="polite">
                {{ bannerText }}
                <span v-if="board.total.paused > 0" class="wb-banner-note">
                    · {{ $t("wallboardPaused", { count: board.total.paused }) }}
                </span>
            </div>

            <main class="wb-main" :class="{ 'wb-with-down': board.downList.length > 0 }">
                <div v-if="board.groups.length === 0" class="wb-empty">{{ $t("wallboardNone") }}</div>

                <div v-else class="wb-tiles">
                    <section
                        v-for="group in board.groups"
                        :key="group.key"
                        class="wb-tile"
                        :class="'wb-tile-' + group.state"
                    >
                        <h2 class="wb-tile-name">{{ group.name || $t("wallboardNoCategory") }}</h2>
                        <div class="wb-tile-count">
                            <span class="wb-big">{{ group.counts.up }}</span>
                            <span class="wb-of">/ {{ activeTotal(group.counts) }}</span>
                        </div>
                        <div class="wb-tile-state">{{ stateText(group.state) }}</div>
                        <ul v-if="showSubs(group)" class="wb-subs">
                            <li v-for="sub in group.subs" :key="sub.key" :class="'wb-sub-' + sub.state">
                                <span class="wb-sub-name">{{ sub.name || $t("wallboardNoSub") }}</span>
                                <span class="wb-sub-count">{{ sub.counts.up }}/{{ activeTotal(sub.counts) }}</span>
                            </li>
                        </ul>
                    </section>
                </div>

                <aside v-if="board.downList.length > 0" class="wb-down" :aria-label="$t('wallboardDownTitle')">
                    <h2 class="wb-down-title">{{ $t("wallboardDownTitle") }}</h2>
                    <ul>
                        <li v-for="d in shownDown" :key="d.id">
                            <div class="wb-down-name">{{ d.name }}</div>
                            <div class="wb-down-meta">
                                <span>{{ [d.ip, d.category, d.subcategory].filter((x) => x).join(" · ") }}</span>
                                <span v-if="downFor(d) !== ''" class="wb-down-since">{{ downFor(d) }}</span>
                            </div>
                        </li>
                    </ul>
                    <div v-if="board.downList.length > shownDown.length" class="wb-more">
                        {{ $t("wallboardMore", { count: board.downList.length - shownDown.length }) }}
                    </div>
                </aside>
            </main>
        </template>
    </div>
</template>

<script>
import dayjs from "dayjs";
import Login from "../components/Login.vue";
import { buildWallboard, formatSince } from "../network-wallboard.js";

const MAX_DOWN_ROWS = 8;
const REFRESH_MS = 60 * 1000;
const SOUND_KEY = "wallboardSound";

export default {
    components: { Login },

    data() {
        return {
            devices: [],
            categories: [],
            now: Date.now(),
            sound: false,
            timer: null,
            refreshTimer: null,
            audio: null,
            wakeLock: null,
            lastDown: null,
        };
    },

    computed: {
        /**
         * @returns {string[]} Names of the categories in the address (?kategori=A,B), empty for all
         */
        only() {
            const raw = this.$route.query.kategori ?? this.$route.query.category ?? "";
            const list = Array.isArray(raw) ? raw : [raw];
            return list
                .join(",")
                .split(",")
                .map((name) => name.trim())
                .filter((name) => name !== "");
        },

        board() {
            const root = this.$root;
            return buildWallboard({
                devices: this.devices,
                categories: this.categories,
                lastBeat: (id) => root.lastHeartbeatList[id],
                isActive: (id) => root.monitorList[id]?.active !== false,
                beatsOf: (id) => root.heartbeatList[id],
                only: this.only,
            });
        },

        shownDown() {
            return this.board.downList.slice(0, MAX_DOWN_ROWS);
        },

        bannerText() {
            const t = this.board.total;
            switch (this.board.state) {
                case "down":
                    return this.$t("wallboardDownCount", { count: t.down });
                case "pending":
                    return this.$t("wallboardPending", { count: t.pending });
                case "maintenance":
                    return this.$t("wallboardMaintenance");
                case "up":
                    return this.$t("wallboardAllNormal", { count: t.up });
                default:
                    return this.$t("wallboardNone");
            }
        },

        clockTime() {
            return dayjs(this.now).format("HH:mm:ss");
        },

        clockDate() {
            return dayjs(this.now).format("dddd, D MMMM YYYY");
        },

        units() {
            return {
                second: this.$t("wallboardUnitSecond"),
                minute: this.$t("wallboardUnitMinute"),
                hour: this.$t("wallboardUnitHour"),
                day: this.$t("wallboardUnitDay"),
            };
        },
    },

    watch: {
        "$root.loggedIn"(value) {
            if (value) {
                this.loadData();
            }
        },

        "$root.socket.connected"(value) {
            if (value && this.$root.loggedIn) {
                this.loadData();
            }
        },

        "board.total.down"(value) {
            // A device that went down while the page is open: a short alarm, once per new device
            if (this.lastDown !== null && value > this.lastDown && this.sound) {
                this.beep();
            }
            this.lastDown = value;
        },
    },

    mounted() {
        try {
            this.sound = localStorage.getItem(SOUND_KEY) === "1";
        } catch (e) {
            this.sound = false;
        }
        const socket = this.$root.getSocket();
        socket.on("networkDeviceList", this.onDeviceList);
        socket.on("networkCategoryList", this.onCategoryList);
        this.timer = setInterval(() => {
            this.now = Date.now();
        }, 1000);
        this.refreshTimer = setInterval(() => {
            if (this.$root.loggedIn) {
                this.loadData();
            }
        }, REFRESH_MS);
        document.addEventListener("visibilitychange", this.keepAwake);
        if (this.$root.loggedIn) {
            this.loadData();
        }
        this.keepAwake();
        document.title = "Wallboard";
    },

    beforeUnmount() {
        const socket = this.$root.getSocket();
        socket.off("networkDeviceList", this.onDeviceList);
        socket.off("networkCategoryList", this.onCategoryList);
        clearInterval(this.timer);
        clearInterval(this.refreshTimer);
        document.removeEventListener("visibilitychange", this.keepAwake);
        if (this.wakeLock) {
            this.wakeLock.release().catch(() => {});
        }
        if (this.audio) {
            this.audio.close().catch(() => {});
        }
    },

    methods: {
        /**
         * Load the inventory and the categories.
         * @returns {void}
         */
        loadData() {
            const socket = this.$root.getSocket();
            socket.emit("getNetworkCategories", (res) => {
                if (res.ok) {
                    this.onCategoryList(res.categories);
                }
            });
            socket.emit("getNetworkDevices", (res) => {
                if (res.ok) {
                    this.onDeviceList(res.devices);
                }
            });
        },

        /**
         * @param {object[]} devices Inventory from the server
         * @returns {void}
         */
        onDeviceList(devices) {
            this.devices = devices;
        },

        /**
         * @param {object[]} categories Categories from the server
         * @returns {void}
         */
        onCategoryList(categories) {
            this.categories = categories;
        },

        /**
         * Devices that are not paused: those the count "up of total" is about.
         * @param {{total: number, paused: number}} counts Counts of a group
         * @returns {number} Number of devices that are running
         */
        activeTotal(counts) {
            return counts.total - counts.paused;
        },

        /**
         * Sub categories are shown when they say something the category does not: a name, or more than one.
         * @param {{subs: {name: string}[]}} group Group
         * @returns {boolean} True to show the list
         */
        showSubs(group) {
            return group.subs.length > 1 || (group.subs.length === 1 && group.subs[0].name !== "");
        },

        /**
         * @param {string} state State of a group
         * @returns {string} Word to show under the count, so the colour is not the only sign
         */
        stateText(state) {
            return this.$t(`wallboardState_${state}`);
        },

        /**
         * @param {{since: ?number, atLeast: boolean}} device Device that is down
         * @returns {string} How long it has been down, "" when that is not known
         */
        downFor(device) {
            if (device.since === null) {
                return "";
            }
            const text = formatSince(this.now - device.since, this.units);
            return text === "" ? "" : (device.atLeast ? "≥ " : "") + text;
        },

        /**
         * Switch the alarm on or off. Browsers allow sound only after a click, so this is where the audio starts.
         * @returns {void}
         */
        toggleSound() {
            this.sound = !this.sound;
            try {
                localStorage.setItem(SOUND_KEY, this.sound ? "1" : "0");
            } catch (e) {
                // Without storage the choice only lasts until the page is closed
            }
            if (this.sound) {
                this.beep();
            }
        },

        /**
         * Play two short tones.
         * @returns {void}
         */
        beep() {
            try {
                const Context = window.AudioContext || window.webkitAudioContext;
                if (!Context) {
                    return;
                }
                this.audio = this.audio || new Context();
                if (this.audio.state === "suspended") {
                    this.audio.resume();
                }
                const start = this.audio.currentTime;
                [880, 660].forEach((frequency, i) => {
                    const osc = this.audio.createOscillator();
                    const gain = this.audio.createGain();
                    osc.frequency.value = frequency;
                    gain.gain.setValueAtTime(0.2, start + i * 0.25);
                    gain.gain.exponentialRampToValueAtTime(0.001, start + i * 0.25 + 0.22);
                    osc.connect(gain).connect(this.audio.destination);
                    osc.start(start + i * 0.25);
                    osc.stop(start + i * 0.25 + 0.25);
                });
            } catch (e) {
                console.warn("Could not play the alarm:", e);
            }
        },

        /**
         * @returns {void}
         */
        toggleFullscreen() {
            if (document.fullscreenElement) {
                document.exitFullscreen();
            } else {
                document.documentElement.requestFullscreen?.().catch(() => {});
            }
        },

        /**
         * Ask the browser not to turn the screen off while the wallboard is visible.
         * @returns {Promise<void>}
         */
        async keepAwake() {
            try {
                if (document.visibilityState === "visible" && navigator.wakeLock) {
                    this.wakeLock = await navigator.wakeLock.request("screen");
                }
            } catch (e) {
                // Not allowed or not supported: the screen may turn off by the settings of the computer
            }
        },
    },
};
</script>

<style lang="scss" scoped>
.wallboard {
    --wb-bg: #0d1117;
    --wb-panel: #161b22;
    --wb-text: #e6edf3;
    --wb-muted: #9aa7b4;
    --wb-up: #2ea043;
    --wb-down: #f85149;
    --wb-pending: #d29922;
    --wb-maintenance: #58a6ff;
    --wb-none: #6e7681;

    position: fixed;
    inset: 0;
    display: flex;
    flex-direction: column;
    gap: 1.2vmin;
    padding: 1.6vmin 2vmin;
    background: var(--wb-bg);
    color: var(--wb-text);
    overflow: auto;
}

.wb-header {
    display: flex;
    align-items: center;
    gap: 2vmin;
}

.wb-title {
    flex: 1;
    font-size: clamp(1rem, 2.4vmin, 2.2rem);
    font-weight: 600;
}

.wb-clock {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    line-height: 1.1;
}

.wb-time {
    font-size: clamp(1.4rem, 4vmin, 3.4rem);
    font-variant-numeric: tabular-nums;
    font-weight: 700;
}

.wb-date {
    font-size: clamp(0.8rem, 1.7vmin, 1.4rem);
    color: var(--wb-muted);
}

.wb-tools {
    display: flex;
    gap: 0.6vmin;
}

.wb-tool {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: clamp(2rem, 4vmin, 3rem);
    height: clamp(2rem, 4vmin, 3rem);
    border: 1px solid #30363d;
    border-radius: 0.5rem;
    background: transparent;
    color: var(--wb-muted);
    text-decoration: none;
    cursor: pointer;

    &:hover,
    &:focus-visible {
        color: var(--wb-text);
        border-color: var(--wb-muted);
    }
}

.wb-offline {
    padding: 0.8vmin 1.6vmin;
    border-radius: 0.5rem;
    background: var(--wb-down);
    color: #fff;
    font-size: clamp(1rem, 2.2vmin, 1.8rem);
    font-weight: 700;
    text-align: center;
}

.wb-banner {
    padding: 1.4vmin 2vmin;
    border-radius: 0.8rem;
    background: var(--wb-panel);
    border-left: 1.2vmin solid var(--wb-none);
    font-size: clamp(1.4rem, 5vmin, 4.2rem);
    font-weight: 800;
    letter-spacing: 0.02em;
}

.wb-banner-note {
    font-size: 0.4em;
    font-weight: 500;
    color: var(--wb-muted);
}

.wb-state-up .wb-banner {
    border-left-color: var(--wb-up);
}

.wb-state-down .wb-banner {
    border-left-color: var(--wb-down);
    background: rgba(248, 81, 73, 0.16);
    animation: wb-pulse 2.4s ease-in-out infinite;
}

.wb-state-pending .wb-banner {
    border-left-color: var(--wb-pending);
}

.wb-state-maintenance .wb-banner {
    border-left-color: var(--wb-maintenance);
}

@keyframes wb-pulse {
    50% {
        background: rgba(248, 81, 73, 0.3);
    }
}

@media (prefers-reduced-motion: reduce) {
    .wb-state-down .wb-banner {
        animation: none;
    }
}

.wb-main {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 1.6vmin;
}

.wb-main.wb-with-down {
    grid-template-columns: minmax(0, 2fr) minmax(18rem, 1fr);
}

.wb-empty {
    padding: 6vmin;
    color: var(--wb-muted);
    font-size: clamp(1.2rem, 3vmin, 2.4rem);
    text-align: center;
}

.wb-tiles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(clamp(14rem, 24vmin, 24rem), 1fr));
    grid-auto-rows: min-content;
    align-content: start;
    gap: 1.6vmin;
}

.wb-tile {
    padding: 1.6vmin 1.8vmin;
    border-radius: 0.8rem;
    background: var(--wb-panel);
    border-top: 0.9vmin solid var(--wb-none);
}

.wb-tile-up {
    border-top-color: var(--wb-up);
}

.wb-tile-down {
    border-top-color: var(--wb-down);
    background: rgba(248, 81, 73, 0.14);
}

.wb-tile-pending {
    border-top-color: var(--wb-pending);
}

.wb-tile-maintenance {
    border-top-color: var(--wb-maintenance);
}

.wb-tile-name {
    margin: 0;
    font-size: clamp(1rem, 2.6vmin, 2.2rem);
    font-weight: 700;
    overflow-wrap: anywhere;
}

.wb-tile-count {
    display: flex;
    align-items: baseline;
    gap: 0.8vmin;
    margin-top: 0.6vmin;
}

.wb-big {
    font-size: clamp(2.4rem, 9vmin, 7.5rem);
    font-weight: 800;
    line-height: 1;
    font-variant-numeric: tabular-nums;
}

.wb-of {
    font-size: clamp(1rem, 3vmin, 2.4rem);
    color: var(--wb-muted);
}

.wb-tile-state {
    font-size: clamp(0.8rem, 1.9vmin, 1.5rem);
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
}

.wb-tile-up .wb-tile-state {
    color: var(--wb-up);
}

.wb-tile-down .wb-tile-state {
    color: var(--wb-down);
}

.wb-tile-pending .wb-tile-state {
    color: var(--wb-pending);
}

.wb-tile-maintenance .wb-tile-state {
    color: var(--wb-maintenance);
}

.wb-tile-none .wb-tile-state {
    color: var(--wb-muted);
}

.wb-subs {
    display: flex;
    flex-direction: column;
    gap: 0.4vmin;
    margin: 1vmin 0 0;
    padding: 0;
    list-style: none;
    font-size: clamp(0.8rem, 1.9vmin, 1.5rem);

    li {
        display: flex;
        justify-content: space-between;
        gap: 1vmin;
        padding: 0.3vmin 0.8vmin;
        border-left: 0.5vmin solid var(--wb-up);
        color: var(--wb-muted);
    }

    .wb-sub-down {
        border-left-color: var(--wb-down);
        color: var(--wb-text);
        font-weight: 700;
    }

    .wb-sub-pending {
        border-left-color: var(--wb-pending);
    }

    .wb-sub-maintenance {
        border-left-color: var(--wb-maintenance);
    }

    .wb-sub-none {
        border-left-color: var(--wb-none);
    }
}

.wb-sub-count {
    font-variant-numeric: tabular-nums;
}

.wb-down {
    padding: 1.4vmin 1.6vmin;
    border-radius: 0.8rem;
    background: var(--wb-panel);
    border-top: 0.9vmin solid var(--wb-down);
    overflow: auto;

    ul {
        margin: 0;
        padding: 0;
        list-style: none;
    }

    li {
        padding: 0.8vmin 0;
        border-bottom: 1px solid #30363d;
    }
}

.wb-down-title {
    margin: 0 0 0.8vmin;
    font-size: clamp(1rem, 2.6vmin, 2.2rem);
    font-weight: 700;
    color: var(--wb-down);
}

.wb-down-name {
    font-size: clamp(1rem, 2.4vmin, 2rem);
    font-weight: 700;
    overflow-wrap: anywhere;
}

.wb-down-meta {
    display: flex;
    justify-content: space-between;
    gap: 1vmin;
    font-size: clamp(0.75rem, 1.7vmin, 1.4rem);
    color: var(--wb-muted);
}

.wb-down-since {
    flex-shrink: 0;
    color: var(--wb-text);
    font-weight: 700;
    font-variant-numeric: tabular-nums;
}

.wb-more {
    margin-top: 1vmin;
    color: var(--wb-muted);
    font-size: clamp(0.8rem, 1.8vmin, 1.5rem);
}

@media (max-width: 800px) {
    .wb-main.wb-with-down {
        grid-template-columns: minmax(0, 1fr);
    }
}
</style>
