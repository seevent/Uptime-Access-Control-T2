exports.up = function (knex) {
    return knex.schema.createTable("network_device", (table) => {
        table.increments("id");
        table.string("ip", 45).notNullable().unique();
        table.string("mac", 17).nullable();
        table.string("hostname", 255).nullable();
        table.string("vendor", 255).nullable();
        table.string("label", 255).nullable();
        table.string("detected_via", 10).notNullable();
        table.datetime("first_seen").notNullable();
        table.datetime("last_seen").notNullable();
        table.boolean("is_online").notNullable().defaultTo(false);
        table
            .integer("monitor_id")
            .unsigned()
            .nullable()
            .index()
            .references("id")
            .inTable("monitor")
            .onDelete("SET NULL");
    });
};

exports.down = function (knex) {
    return knex.schema.dropTable("network_device");
};
