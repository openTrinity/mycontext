"""Build deterministic persona Layer A artifacts from an existing graph."""

from __future__ import annotations

import argparse
import json

from kl_graph import config


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("-c", "--config", help="Additional YAML configuration")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate identity and report corpus sizes without writing persona.db",
    )
    args = parser.parse_args()
    if args.config:
        config.load_config(args.config)

    # Import after load_config so modules observe the resolved configuration.
    from kl_graph.persona.cache import PersonaStore
    from kl_graph.persona.config import PersonaSettings
    from kl_graph.persona.corpus import PersonaCorpusReader
    from kl_graph.persona.features import build_all_features
    from kl_graph.storage.sqlite_store import SQLiteStore

    settings = PersonaSettings.from_config()
    settings.validate_owner()
    knowledge_path = config.DATA_DIR / "knowledge.db"
    if not knowledge_path.is_file():
        raise SystemExit(f"knowledge database not found: {knowledge_path}")

    with SQLiteStore(knowledge_path) as store:
        reader = PersonaCorpusReader(store, settings)
        if args.dry_run:
            corpora = reader.interlocutor_corpora()
            report = {
                "messages": len(reader.messages()),
                "interlocutors": len(corpora),
                "eligible_interlocutors": sum(
                    len(corpus.ego_messages) >= settings.min_messages
                    for corpus in corpora
                ),
                "stance_facts": len(reader.stance_facts()),
            }
        else:
            with PersonaStore(settings.db_path) as persona_db:
                report = build_all_features(
                    reader,
                    persona_db,
                    min_messages=settings.min_messages,
                )
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
