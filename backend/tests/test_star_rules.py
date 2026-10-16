import unittest

from app.core import stars as rules
from app.core.stars import Perm


class TestRoles(unittest.TestCase):
    def test_hierarchy(self):
        self.assertTrue(rules.outranks("owner", "admin"))
        self.assertTrue(rules.outranks("admin", "moderator"))
        self.assertTrue(rules.outranks("moderator", "member"))
        self.assertFalse(rules.outranks("moderator", "moderator"))
        self.assertFalse(rules.outranks("admin", "owner"))

    def test_role_assignment(self):
        # Модераторов назначают владелец и админы.
        self.assertTrue(rules.can_set_role("admin", "member", "moderator"))
        self.assertTrue(rules.can_set_role("owner", "member", "moderator"))
        # Админов — только владелец.
        self.assertFalse(rules.can_set_role("admin", "member", "admin"))
        self.assertTrue(rules.can_set_role("owner", "moderator", "admin"))
        self.assertFalse(rules.can_set_role("admin", "admin", "member"))
        self.assertTrue(rules.can_set_role("owner", "admin", "member"))
        # Роль владельца — только передачей Звезды.
        self.assertFalse(rules.can_set_role("owner", "admin", "owner"))
        self.assertFalse(rules.can_set_role("moderator", "member", "moderator"))


class TestPermissions(unittest.TestCase):
    def test_defaults(self):
        perms = rules.normalize_role_permissions(None)
        self.assertTrue(rules.has_perm("moderator", Perm.KICK, perms))
        self.assertFalse(rules.has_perm("moderator", Perm.MANAGE_CHANNELS, perms))
        self.assertTrue(rules.has_perm("member", Perm.INVITE, perms))
        self.assertFalse(rules.has_perm("member", Perm.KICK, perms))
        self.assertTrue(rules.has_perm("admin", Perm.MANAGE_CHANNELS, perms))

    def test_member_cannot_be_granted_moderation(self):
        perms = rules.normalize_role_permissions(
            {"moderator": [], "member": ["kick", "delete_messages", "invite", "bogus"]}
        )
        self.assertEqual(perms["member"], ["invite"])
        self.assertFalse(rules.has_perm("moderator", Perm.KICK, perms))

    def test_kick_and_ban(self):
        perms = rules.normalize_role_permissions(None)
        self.assertTrue(rules.can_kick("moderator", "member", perms))
        self.assertFalse(rules.can_kick("moderator", "admin", perms))
        no_kick = rules.normalize_role_permissions({"moderator": [], "member": []})
        self.assertFalse(rules.can_kick("moderator", "member", no_kick))
        # Блокируют только владелец и админ — модератору это право не выдаётся.
        self.assertFalse(rules.can_ban("moderator", "member"))
        self.assertTrue(rules.can_ban("admin", "moderator"))
        self.assertFalse(rules.can_ban("admin", "admin"))

    def test_delete_messages(self):
        perms = rules.normalize_role_permissions(None)
        self.assertTrue(rules.can_delete_message("u1", "member", "u1", "member", perms))
        self.assertFalse(rules.can_delete_message("u1", "member", "u2", "member", perms))
        self.assertTrue(rules.can_delete_message("u1", "moderator", "u2", "member", perms))
        self.assertFalse(rules.can_delete_message("u1", "moderator", "u2", "admin", perms))
        self.assertTrue(rules.can_delete_message("u1", "moderator", "u2", None, perms))


class TestLimits(unittest.TestCase):
    def test_channel_limits(self):
        self.assertEqual(rules.channel_limit("gaming", "satellite"), 3)
        self.assertEqual(rules.channel_limit("gaming", "planet"), 5)
        self.assertIsNone(rules.channel_limit("work", "planet"))

    def test_capacity_defaults_within_cap(self):
        for kind in rules.ROOM_KINDS:
            self.assertLessEqual(rules.default_capacity(kind), rules.PLANET_MAX_CAPACITY)


if __name__ == "__main__":
    unittest.main()
