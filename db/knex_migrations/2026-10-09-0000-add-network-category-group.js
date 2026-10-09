// Every network category (and sub category) is shown as a group monitor on the dashboard.
// The link is a plain column without a foreign key on purpose: when the group monitor is deleted the id stays
// behind, so the sync can tell "the group was deleted" (id no longer exists) apart from "no group yet" (null).
exports.up = async function (knex) {
    await knex.schema.alterTable("network_category", (table) => {
        table.integer("group_monitor_id").unsigned().nullable().index();
    });
};

exports.down = async function (knex) {
    await knex.schema.alterTable("network_category", (table) => {
        table.dropIndex("group_monitor_id");
        table.dropColumn("group_monitor_id");
    });
};
