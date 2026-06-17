"""Export the original Smart USB Guardian SQLite database for optional Netlify import."""

from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path
from typing import Any


def table_exists(connection: sqlite3.Connection, table: str) -> bool:
    row = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        (table,),
    ).fetchone()
    return row is not None


def rows(connection: sqlite3.Connection, table: str) -> list[dict[str, Any]]:
    if not table_exists(connection, table):
        return []
    cursor = connection.execute(f'SELECT * FROM "{table}"')
    names = [column[0] for column in cursor.description]
    return [dict(zip(names, row, strict=True)) for row in cursor.fetchall()]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "database",
        nargs="?",
        default="usb_guardian.db",
        help="Path to the original usb_guardian.db",
    )
    parser.add_argument(
        "--output",
        default="netlify-migration.json",
        help="Output JSON file",
    )
    args = parser.parse_args()

    database = Path(args.database).resolve()
    output = Path(args.output).resolve()

    connection = sqlite3.connect(database)
    try:
        payload = {
            "users": rows(connection, "users"),
            "devices": rows(connection, "devices"),
            "events": rows(connection, "events"),
            "connection_states": rows(connection, "connection_states"),
        }
    finally:
        connection.close()

    output.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"Exported {database} to {output}")
    for key, value in payload.items():
        print(f"  {key}: {len(value)}")


if __name__ == "__main__":
    main()
