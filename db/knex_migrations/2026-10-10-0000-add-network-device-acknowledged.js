// A device found by a scan that nobody has confirmed yet is "unknown" (acknowledged = 0).
// Every device that exists before this migration is already part of the inventory, so it counts as known.
exports.up = async function (knex) {
    await knex.schema.alterTable("network_device", (table) => {
        table.boolean("acknowledged").notNullable().defaultTo(true);
        table.string("alert_note", 255).nullable();
    });
};

exports.down = async function (knex) {
    await knex.schema.alterTable("network_device", (table) => {
        table.dropColumn("alert_note");
        table.dropColumn("acknowledged");
    });
};
