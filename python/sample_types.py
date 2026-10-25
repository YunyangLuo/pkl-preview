"""Importable stand-in used to test old scipy states that omit _xp."""


class NeedsXp:
    def __setstate__(self, state):
        state.pop("_xp")
        self.__dict__.update(state)
