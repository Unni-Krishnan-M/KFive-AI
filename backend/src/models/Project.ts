import { Schema, model } from 'mongoose';

export type ProjectStatus = 'active' | 'archived';
export type ProjectActivityType = 'created' | 'updated' | 'renamed' | 'archived' | 'restored';

export interface ProjectActivityEvent {
  type: ProjectActivityType;
  timestamp: Date;
  actorId: Schema.Types.ObjectId;
  changes?: Record<string, unknown>;
}

const activitySchema = new Schema<ProjectActivityEvent>({
  type: {
    type: String,
    enum: ['created', 'updated', 'renamed', 'archived', 'restored'],
    required: true,
  },
  timestamp: { type: Date, required: true, default: Date.now },
  actorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  changes: { type: Schema.Types.Mixed },
}, { _id: true });

const projectSchema = new Schema({
  ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true, index: true },
  name: { type: String, required: true, trim: true, minlength: 1, maxlength: 120 },
  description: { type: String, trim: true, default: '', maxlength: 2000 },
  tags: {
    type: [{ type: String, trim: true, minlength: 1, maxlength: 40 }],
    default: [],
    validate: [
      {
        validator: (tags: string[]) => tags.length <= 20,
        message: 'A project can have at most 20 tags.',
      },
      {
        validator: (tags: string[]) => new Set(tags.map((tag) => tag.toLocaleLowerCase())).size === tags.length,
        message: 'Project tags must be unique.',
      },
    ],
  },
  status: { type: String, enum: ['active', 'archived'], default: 'active', index: true },
  activity: {
    type: [activitySchema],
    default: [],
    validate: {
      validator: (events: ProjectActivityEvent[]) => events.length <= 100,
      message: 'Project activity history cannot exceed 100 events.',
    },
  },
  lastActivityAt: { type: Date, required: true, default: Date.now, index: true },
}, { timestamps: true });

projectSchema.index({ ownerId: 1, status: 1, lastActivityAt: -1 });
projectSchema.index({ ownerId: 1, updatedAt: -1 });

export const ProjectModel = model('Project', projectSchema);

