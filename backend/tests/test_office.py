"""Карта офиса: геометрия плана и сценарии этажей/сохранения на настоящей PostgreSQL."""

import unittest

from fastapi import HTTPException
from sqlalchemy import update

from app.api import office as office_api
from app.api import stars as api
from app.core import office
from app.core.office import Rect
from app.models.star import StarChannel, StarFloor
from app.schemas.star import (
    CreateChannel,
    CreateFloor,
    LayoutRoom,
    SaveLayout,
    UpdateChannel,
    UpdateRolePermissions,
)
from tests.stars_base import StarsTestBase


class TestGeometry(unittest.TestCase):
    def test_touching_walls_is_not_overlap(self):
        self.assertFalse(office.overlaps(Rect(0, 0, 4, 3), Rect(4, 0, 4, 3)))
        self.assertFalse(office.overlaps(Rect(0, 0, 4, 3), Rect(0, 3, 4, 3)))
        self.assertTrue(office.overlaps(Rect(0, 0, 4, 3), Rect(3, 2, 4, 3)))

    def test_layout_errors(self):
        self.assertIsNone(office.layout_error(Rect(0, 0, 4, 3)))
        self.assertIn("меньше", office.layout_error(Rect(0, 0, 1, 3)))
        self.assertIn("больше", office.layout_error(Rect(0, 0, office.MAX_W + 1, 3)))
        self.assertIn("границы", office.layout_error(Rect(office.GRID_W - 2, 0, 4, 3)))
        self.assertIn("границы", office.layout_error(Rect(-1, 0, 4, 3)))

    def test_free_spot_skips_occupied(self):
        spot = office.find_free_spot([Rect(0, 0, 8, 5)], 5, 4)
        self.assertEqual(spot, Rect(8, 0, 5, 4))

    def test_place_shrinks_when_floor_is_crowded(self):
        # Свободна только полоса высотой 2 внизу.
        occupied = [Rect(0, 0, office.GRID_W, office.GRID_H - 2)]
        spot = office.place(occupied, "coworking")
        self.assertIsNotNone(spot)
        self.assertEqual(spot.h, 2)
        self.assertIsNone(office.place([Rect(0, 0, office.GRID_W, office.GRID_H)], "meeting"))


class OfficeApiTest(StarsTestBase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.star = await self.star_with_roles("work")

    def planets(self, detail):
        return [c for c in detail.channels if c.kind == "planet"]

    async def layout_of(self, floor_id):
        detail = await self.call(api.get_star, self.star.id, user="owner")
        floor = next(f for f in detail.floors if f.id == floor_id)
        rooms = [
            LayoutRoom(channel_id=c.id, x=c.map_x, y=c.map_y, w=c.map_w, h=c.map_h)
            for c in self.planets(detail)
            if c.floor_id == floor_id
        ]
        return floor, rooms

    async def test_work_star_gets_first_floor_with_placed_rooms(self):
        detail = await self.call(api.get_star, self.star.id, user="alice")
        self.assertEqual([f.name for f in detail.floors], ["1 этаж"])
        rects = [Rect(c.map_x, c.map_y, c.map_w, c.map_h) for c in self.planets(detail)]
        self.assertEqual(len(rects), 2)
        self.assertTrue(all(office.layout_error(r) is None for r in rects))
        self.assertIsNone(office.first_overlap(rects))

    async def test_gaming_star_has_no_map(self):
        gaming = await self.make_star("gaming", name="Игры")
        self.assertEqual(gaming.floors, [])
        await self.expect_error(400, office_api.create_floor, gaming.id, CreateFloor(name="2"), user="owner")

    async def test_star_from_before_the_map_gets_a_floor(self):
        async with self.Session() as db:
            await db.execute(
                update(StarChannel)
                .where(StarChannel.star_id == self.star.id)
                .values(floor_id=None, map_x=None, map_y=None, map_w=None, map_h=None)
            )
            from sqlalchemy import delete

            await db.execute(delete(StarFloor).where(StarFloor.star_id == self.star.id))
            await db.commit()
        detail = await self.call(api.get_star, self.star.id, user="bob")
        self.assertEqual(len(detail.floors), 1)
        self.assertTrue(all(c.floor_id == detail.floors[0].id and c.map_x is not None for c in self.planets(detail)))

    async def test_new_room_lands_on_a_free_spot_of_the_chosen_floor(self):
        second = await self.call(office_api.create_floor, self.star.id, CreateFloor(name="2 этаж"), user="admin")
        kitchen = await self.call(
            api.create_channel,
            self.star.id,
            CreateChannel(kind="planet", name="Кухня", room_kind="kitchen", floor_id=second.id),
            user="owner",
        )
        self.assertEqual(kitchen.floor_id, second.id)
        self.assertEqual((kitchen.map_x, kitchen.map_y, kitchen.map_w, kitchen.map_h), (0, 0, 5, 4))

        first = (await self.call(api.get_star, self.star.id, user="owner")).floors[0]
        room = await self.call(api.create_channel, self.star.id, CreateChannel(kind="planet", name="Ещё"), user="owner")
        self.assertEqual(room.floor_id, first.id)
        detail = await self.call(api.get_star, self.star.id, user="owner")
        on_first = [Rect(c.map_x, c.map_y, c.map_w, c.map_h) for c in self.planets(detail) if c.floor_id == first.id]
        self.assertIsNone(office.first_overlap(on_first))

    async def test_save_layout(self):
        floor, rooms = await self.layout_of((await self.call(api.get_star, self.star.id, user="owner")).floors[0].id)
        moved = [LayoutRoom(channel_id=r.channel_id, x=i * 10, y=10, w=6, h=4) for i, r in enumerate(rooms)]
        self.events.clear()
        out = await self.call(office_api.save_layout, self.star.id, floor.id, SaveLayout(version=floor.version, rooms=moved), user="admin")
        self.assertEqual(out.floor.version, floor.version + 1)
        self.assertTrue(any(e["type"] == "star_layout" for _, e in self.events))
        _, saved = await self.layout_of(floor.id)
        self.assertEqual(sorted((r.x, r.y) for r in saved), [(0, 10), (10, 10)])

    async def test_save_layout_rejects_stale_and_invalid_plans(self):
        floor, rooms = await self.layout_of((await self.call(api.get_star, self.star.id, user="owner")).floors[0].id)

        # Кто-то сохранил раньше нас.
        await self.call(office_api.save_layout, self.star.id, floor.id, SaveLayout(version=floor.version, rooms=rooms), user="owner")
        await self.expect_error(409, office_api.save_layout, self.star.id, floor.id, SaveLayout(version=floor.version, rooms=rooms), user="admin")

        floor, rooms = await self.layout_of(floor.id)
        # Пропала комната (её удалили/перенесли, пока мы правили).
        await self.expect_error(409, office_api.save_layout, self.star.id, floor.id, SaveLayout(version=floor.version, rooms=rooms[:1]), user="owner")
        # Наложение.
        clash = [LayoutRoom(channel_id=r.channel_id, x=0, y=0, w=4, h=4) for r in rooms]
        err = await self.expect_error(422, office_api.save_layout, self.star.id, floor.id, SaveLayout(version=floor.version, rooms=clash), user="owner")
        self.assertIn("налезают", err.detail)
        # За границей этажа.
        outside = [rooms[0].model_copy(update={"x": office.GRID_W - 1}), *rooms[1:]]
        await self.expect_error(422, office_api.save_layout, self.star.id, floor.id, SaveLayout(version=floor.version, rooms=outside), user="owner")

    async def test_map_editing_rights(self):
        floor, rooms = await self.layout_of((await self.call(api.get_star, self.star.id, user="owner")).floors[0].id)
        body = SaveLayout(version=floor.version, rooms=rooms)
        await self.expect_error(403, office_api.save_layout, self.star.id, floor.id, body, user="alice")
        await self.expect_error(403, office_api.save_layout, self.star.id, floor.id, body, user="mod")
        await self.call(
            api.update_permissions, self.star.id,
            UpdateRolePermissions(moderator=["edit_map"], member=[]), user="owner",
        )
        await self.call(office_api.save_layout, self.star.id, floor.id, body, user="mod")

    async def test_move_room_to_another_floor(self):
        second = await self.call(office_api.create_floor, self.star.id, CreateFloor(name="2 этаж"), user="owner")
        room = self.planets(await self.call(api.get_star, self.star.id, user="owner"))[0]
        moved = await self.call(api.update_channel, self.star.id, room.id, UpdateChannel(floor_id=second.id), user="admin")
        self.assertEqual(moved.floor_id, second.id)
        self.assertEqual((moved.map_x, moved.map_y), (0, 0))

    async def test_delete_floor_moves_rooms_and_keeps_last_floor(self):
        first = (await self.call(api.get_star, self.star.id, user="owner")).floors[0]
        second = await self.call(office_api.create_floor, self.star.id, CreateFloor(name="2 этаж"), user="owner")
        room = self.planets(await self.call(api.get_star, self.star.id, user="owner"))[0]
        await self.call(api.update_channel, self.star.id, room.id, UpdateChannel(floor_id=second.id), user="owner")

        await self.call(office_api.delete_floor, self.star.id, second.id, user="owner")
        detail = await self.call(api.get_star, self.star.id, user="owner")
        self.assertEqual([f.id for f in detail.floors], [first.id])
        self.assertTrue(all(c.floor_id == first.id for c in self.planets(detail)))
        rects = [Rect(c.map_x, c.map_y, c.map_w, c.map_h) for c in self.planets(detail)]
        self.assertIsNone(office.first_overlap(rects))

        await self.expect_error(409, office_api.delete_floor, self.star.id, first.id, user="owner")

    async def test_deleting_room_changes_floor_version(self):
        floor = (await self.call(api.get_star, self.star.id, user="owner")).floors[0]
        room = self.planets(await self.call(api.get_star, self.star.id, user="owner"))[0]
        await self.call(api.delete_channel, self.star.id, room.id, user="owner")
        after = (await self.call(api.get_star, self.star.id, user="owner")).floors[0]
        self.assertEqual(after.version, floor.version + 1)


if __name__ == "__main__":
    unittest.main()
