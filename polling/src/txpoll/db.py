from __future__ import annotations

from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session, sessionmaker

from .config import database_url
from .models import Base

_engine = None
_Session = None


def get_engine():
    global _engine, _Session
    if _engine is None:
        url = database_url()
        connect_args = {"check_same_thread": False} if url.startswith("sqlite") else {}
        _engine = create_engine(url, future=True, connect_args=connect_args)
        _Session = sessionmaker(bind=_engine, expire_on_commit=False, future=True)
    return _engine


def get_session() -> Session:
    get_engine()
    return _Session()


def reset_engine() -> None:
    global _engine, _Session
    if _engine is not None:
        _engine.dispose()
    _engine = None
    _Session = None


def init_db() -> None:
    engine = get_engine()
    if database_url().startswith("postgresql"):
        with engine.begin() as connection:
            connection.execute(text("CREATE SCHEMA IF NOT EXISTS polling"))
    Base.metadata.create_all(engine)
