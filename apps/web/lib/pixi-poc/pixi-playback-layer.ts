import {
  Container,
  Graphics,
  Sprite,
  Text,
  type Texture
} from "pixi.js";
import type {
  PlaybackAnnotation,
  PlaybackFrameActor,
  PlaybackFrameBomb,
  PlaybackFrameDroppedWeapon,
  PlaybackFrameEffect,
  PlaybackFrameEvidence,
  PlaybackFrameProjectile,
  PlaybackFrameViewModel
} from "./playback-frame";

export interface PixiPlaybackLayerOptions {
  root: Container;
  radarTexture: Texture;
  mapSize: number;
}

/**
 * Minimal Pixi layer. Its public update contract is intentionally one typed
 * PlaybackFrameViewModel; parser bundles and observation objects cannot cross
 * this boundary.
 */
export class PixiPlaybackLayer {
  private readonly root: Container;
  private readonly map: Sprite;
  private readonly overlay = new Container();
  private mapSize: number;

  constructor(options: PixiPlaybackLayerOptions) {
    this.root = options.root;
    this.mapSize = options.mapSize;
    this.map = new Sprite(options.radarTexture);
    this.map.width = options.mapSize;
    this.map.height = options.mapSize;
    this.root.addChild(this.map, this.overlay);
  }

  setMapSize(mapSize: number): void {
    this.mapSize = mapSize;
    this.map.width = mapSize;
    this.map.height = mapSize;
  }

  setViewport(x: number, y: number, scale: number): void {
    this.root.position.set(x, y);
    this.root.scale.set(scale);
  }

  /** The only per-frame renderer entry point. */
  update(frame: PlaybackFrameViewModel): void {
    this.clearOverlay();
    this.drawProjectiles(frame.projectiles);
    this.drawDroppedWeapons(frame.dropped_weapons);
    this.drawEffects(frame.effects);
    this.drawEvidence(frame.evidence);
    this.drawAnnotations(frame.annotations);
    if (frame.bomb) this.drawBomb(frame.bomb);
    this.drawActors(frame.actors, frame.selected_player_id);
  }

  destroy(): void {
    this.clearOverlay();
    this.map.destroy();
    this.root.removeChild(this.overlay);
    this.overlay.destroy({ children: true });
  }

  private clearOverlay(): void {
    const children = this.overlay.removeChildren();
    for (const child of children) child.destroy({ children: true });
  }

  private px(point: { x: number; y: number }): { x: number; y: number } {
    return { x: point.x * this.mapSize, y: point.y * this.mapSize };
  }

  private circle(
    point: { x: number; y: number },
    radius: number,
    color: number,
    alpha = 1,
    strokeWidth = 0
  ): Graphics {
    const position = this.px(point);
    const graphic = new Graphics();
    graphic.circle(position.x, position.y, radius).fill({ color, alpha });
    if (strokeWidth > 0) graphic.circle(position.x, position.y, radius).stroke({ width: strokeWidth, color, alpha: 0.95 });
    return graphic;
  }

  private drawActors(actors: readonly PlaybackFrameActor[], selectedPlayerId: string): void {
    for (const actor of actors) {
      const position = this.px(actor.radar_position);
      const isSelected = actor.id === selectedPlayerId;
      const color = actor.side === "T" ? 0xf4bd5d : actor.side === "CT" ? 0x71a7ff : 0xd5d9e2;
      const marker = this.circle(actor.radar_position, isSelected ? 9 : 7, color, actor.status === "DEAD" ? 0.25 : 0.95, isSelected ? 2 : 0);
      this.overlay.addChild(marker);
      if (actor.radar_yaw !== undefined && actor.status !== "DEAD") {
        const yaw = (actor.radar_yaw * Math.PI) / 180;
        const heading = new Graphics();
        heading.moveTo(position.x, position.y).lineTo(
          position.x + Math.cos(yaw) * 15,
          position.y + Math.sin(yaw) * 15
        ).stroke({ width: 2, color, alpha: 0.9 });
        this.overlay.addChild(heading);
      }
      const label = new Text({
        text: actor.label,
        style: { fill: 0xf3f5f7, fontSize: isSelected ? 11 : 9, fontFamily: "system-ui" }
      });
      label.position.set(position.x + 10, position.y - 8);
      this.overlay.addChild(label);
    }
  }

  private drawProjectiles(projectiles: readonly PlaybackFrameProjectile[]): void {
    for (const projectile of projectiles) {
      if (projectile.radar_flight_points.length > 1) {
        const path = new Graphics();
        const first = this.px(projectile.radar_flight_points[0]!);
        path.moveTo(first.x, first.y);
        for (const point of projectile.radar_flight_points.slice(1)) {
          const next = this.px(point);
          path.lineTo(next.x, next.y);
        }
        path.stroke({ width: 2, color: 0xb4c6d9, alpha: 0.85 });
        this.overlay.addChild(path);
      }
      if (projectile.radar_current_position) {
        this.overlay.addChild(this.circle(projectile.radar_current_position, 5, 0xe8edf2, 0.95));
      }
      if (projectile.radar_landing_position) {
        this.overlay.addChild(this.circle(projectile.radar_landing_position, 6, 0x96a6b4, 0.85, 1));
      }
      if (projectile.radar_effect_area) {
        this.overlay.addChild(this.circle(
          projectile.radar_effect_area.center,
          projectile.radar_effect_area.radius * this.mapSize,
          0x9caec2,
          0.08,
          1
        ));
      }
    }
  }

  private drawDroppedWeapons(weapons: readonly PlaybackFrameDroppedWeapon[]): void {
    for (const weapon of weapons) {
      const position = this.px(weapon.radar_position);
      const marker = new Graphics();
      marker.rect(position.x - 4, position.y - 4, 8, 8).fill({ color: 0xd6a85e, alpha: 0.85 });
      this.overlay.addChild(marker);
    }
  }

  private drawEffects(effects: readonly PlaybackFrameEffect[]): void {
    for (const effect of effects) {
      if (effect.radar_position) this.overlay.addChild(this.circle(effect.radar_position, 3, 0xe5eef8, 0.65));
    }
  }

  private drawEvidence(evidence: readonly PlaybackFrameEvidence[]): void {
    for (const item of evidence) {
      const graphic = new Graphics();
      if (item.kind === "SOUND_DIRECTION" || item.kind === "DAMAGE_DIRECTION") {
        const origin = this.px(item.radar_origin);
        const ray = this.px(item.radar_ray_end);
        const left = this.px(item.radar_left_end);
        const right = this.px(item.radar_right_end);
        const color = item.kind === "SOUND_DIRECTION" ? 0x8ac4ff : 0xffb486;
        graphic.moveTo(origin.x, origin.y).lineTo(left.x, left.y)
          .moveTo(origin.x, origin.y).lineTo(right.x, right.y)
          .moveTo(origin.x, origin.y).lineTo(ray.x, ray.y)
          .stroke({ width: 2, color, alpha: 0.8 });
      } else if ("radar_center" in item) {
        const center = this.px(item.radar_center);
        graphic.circle(center.x, center.y, item.radius * this.mapSize)
          .stroke({ width: 2, color: item.kind === "LAST_KNOWN" ? 0xa9b4c4 : 0x89b9d9, alpha: item.opacity ?? 0.5 });
      }
      this.overlay.addChild(graphic);
    }
  }

  private drawAnnotations(annotations: readonly PlaybackAnnotation[]): void {
    for (const annotation of annotations) {
      const graphic = new Graphics();
      if (annotation.kind === "POINT") {
        const point = this.px(annotation.radar_point);
        graphic.circle(point.x, point.y, 5).stroke({ width: 2, color: 0xf2d184, alpha: 0.95 });
      } else if (annotation.kind === "LINE") {
        const from = this.px(annotation.radar_from);
        const to = this.px(annotation.radar_to);
        graphic.moveTo(from.x, from.y).lineTo(to.x, to.y).stroke({ width: 2, color: 0xf2d184, alpha: 0.85 });
      } else {
        const center = this.px(annotation.radar_center);
        graphic.circle(center.x, center.y, annotation.radius * this.mapSize)
          .stroke({ width: 2, color: 0xf2d184, alpha: 0.8 });
      }
      this.overlay.addChild(graphic);
    }
  }

  private drawBomb(bomb: PlaybackFrameBomb): void {
    if (!bomb.radar_position) return;
    const color = bomb.state === "PLANTED" ? 0xf0806b : 0xd4b75f;
    this.overlay.addChild(this.circle(bomb.radar_position, 8, color, 0.95, 2));
  }
}
