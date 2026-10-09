<template>
    <div class="network-bar-chart">
        <div class="chart-wrapper" role="img" :aria-label="ariaLabel">
            <Bar :data="chartData" :options="chartOptions" />
        </div>
        <table class="visually-hidden">
            <caption>
                {{ ariaLabel }}
            </caption>
            <tbody>
                <tr v-for="(label, index) in labels" :key="index">
                    <th scope="row">{{ label }}</th>
                    <td>{{ values[index] }}{{ valueSuffix }}</td>
                </tr>
            </tbody>
        </table>
    </div>
</template>

<script lang="js">
import { BarController, BarElement, CategoryScale, Chart, LinearScale, Tooltip } from "chart.js";
import { Bar } from "vue-chartjs";

Chart.register(BarController, BarElement, CategoryScale, LinearScale, Tooltip);

export default {
    components: { Bar },
    props: {
        /** Text under every bar, for example "2026-10-05" */
        labels: {
            type: Array,
            default: () => [],
        },
        /** One number per bar */
        values: {
            type: Array,
            default: () => [],
        },
        /** Colour of the bars (one series, so one colour) */
        color: {
            type: String,
            default: "#dc3545",
        },
        /** What the numbers are, shown in the tooltip */
        valueLabel: {
            type: String,
            default: "",
        },
        /** Text after the number in the tooltip */
        valueSuffix: {
            type: String,
            default: "",
        },
        /** Short description for screen readers */
        ariaLabel: {
            type: String,
            default: "",
        },
    },
    computed: {
        isLight() {
            return this.$root.theme === "light";
        },

        chartData() {
            return {
                labels: this.labels,
                datasets: [
                    {
                        label: this.valueLabel,
                        data: this.values,
                        backgroundColor: this.color,
                        borderRadius: 4,
                        borderSkipped: "bottom",
                        maxBarThickness: 28,
                    },
                ],
            };
        },

        chartOptions() {
            const text = this.isLight ? "#4b5563" : "#b1b8c0";
            const grid = this.isLight ? "rgba(0,0,0,0.1)" : "rgba(255,255,255,0.1)";
            return {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                scales: {
                    x: {
                        grid: { display: false },
                        ticks: {
                            color: text,
                            maxRotation: 0,
                            autoSkip: true,
                            maxTicksLimit: 8,
                            // "2026-10-05" and "2026-10-05 14:00" shorten to "10-05" and "10-05 14:00"
                            callback: (value) => String(this.labels[value] ?? "").slice(5),
                        },
                    },
                    y: {
                        beginAtZero: true,
                        suggestedMax: 1,
                        grid: { color: grid },
                        ticks: { color: text, precision: 0 },
                    },
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: this.isLight ? "rgba(212,232,222,1.0)" : "rgba(32,42,38,1.0)",
                        titleColor: this.isLight ? "rgba(12,12,18,1.0)" : "rgba(220,220,220,1.0)",
                        bodyColor: this.isLight ? "rgba(12,12,18,1.0)" : "rgba(220,220,220,1.0)",
                        callbacks: {
                            label: (item) => `${this.valueLabel}: ${item.raw}${this.valueSuffix}`,
                        },
                    },
                },
            };
        },
    },
};
</script>

<style lang="scss" scoped>
.chart-wrapper {
    height: 220px;
    position: relative;
}
</style>
