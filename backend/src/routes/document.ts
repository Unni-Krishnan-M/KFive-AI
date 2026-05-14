import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { asyncHandler } from '@/middleware/errorHandler';
import { DocumentModel } from '@/models/Document';
import { AppError } from '@/middleware/errorHandler';
import { getDocumentProcessingQueue } from '@/config/queues';
import { exec } from 'child_process';
import util from 'util';

const execPromise = util.promisify(exec);

const router = Router();

const uploadDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

// Upload and index a document
router.post('/', upload.single('document'), asyncHandler(async (req, res) => {
  const userId = (req as any).user?.userId || 'default-user-id';
  
  if (!req.file) {
    throw new AppError('No file uploaded', 400);
  }

  // Create DB entry
  const doc = await DocumentModel.create({
    userId,
    originalName: req.file.originalname,
    filename: req.file.filename,
    mimeType: req.file.mimetype,
    size: req.file.size,
    path: req.file.path,
    status: 'pending' // Enters queue
  });

  // Attempt to add to processing queue if available
  try {
    const queue = getDocumentProcessingQueue();
    await queue.add('process-document', { documentId: doc._id }, { jobId: doc._id.toString() });
    doc.status = 'processing';
    await doc.save();
  } catch(error) {
    console.error('Queue error', error);
  }

  res.status(201).json({ success: true, data: doc });
}));

// Process Conversions via LibreOffice
router.post('/convert', upload.array('files'), asyncHandler(async (req, res) => {
  const toolId = req.body.toolId;
  const files = req.files as Express.Multer.File[];
  
  if (!files || files.length === 0) {
    throw new AppError('No files uploaded', 400);
  }

  const file = files[0];
  const inputPath = file.path;
  const originalName = file.originalname;
  const ext = path.extname(originalName).toLowerCase();

  let finalFile = '';

  try {
    const outdir = path.dirname(inputPath);
    const basename = path.basename(inputPath, ext);
    const envIsolated = `-env:UserInstallation=file:///tmp/kfive_lo_${Date.now()}`;

    if (toolId.endsWith('-pdf')) {
      await execPromise(`libreoffice ${envIsolated} --headless --convert-to pdf "${inputPath}" --outdir "${outdir}"`);
      finalFile = path.join(outdir, basename + '.pdf');
    } else if (toolId === 'pdf-word') {
      await execPromise(`libreoffice ${envIsolated} --headless --infilter="writer_pdf_import" --convert-to docx "${inputPath}" --outdir "${outdir}"`);
      finalFile = path.join(outdir, basename + '.docx');
    } else if (toolId === 'pdf-excel') {
      await execPromise(`libreoffice ${envIsolated} --headless --infilter="calc_pdf_import" --convert-to xlsx "${inputPath}" --outdir "${outdir}"`);
      finalFile = path.join(outdir, basename + '.xlsx');
    } else if (toolId === 'pdf-ppt') {
      await execPromise(`libreoffice ${envIsolated} --headless --infilter="impress_pdf_import" --convert-to pptx "${inputPath}" --outdir "${outdir}"`);
      finalFile = path.join(outdir, basename + '.pptx');
    } else if (toolId === 'pdf-jpg') {
      await execPromise(`pdftoppm -f 1 -l 1 -jpeg "${inputPath}" "${path.join(outdir, basename)}"`);
      finalFile = path.join(outdir, basename + '-1.jpg');
    } else {
      throw new AppError('Conversion not supported internally yet.', 400);
    }

    if (fs.existsSync(finalFile)) {
      res.download(finalFile, (err) => {
        // cleanup async
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        if (fs.existsSync(finalFile)) fs.unlinkSync(finalFile);
      });
    } else {
      throw new AppError('Conversion failed natively. Check server logs.', 500);
    }
  } catch (err: any) {
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    throw new AppError(err.message || 'Error processing conversion', 500);
  }
}));

// Get all documents for user
router.get('/', asyncHandler(async (req, res) => {
  const userId = (req as any).user?.userId || 'default-user-id';
  const docs = await DocumentModel.find({ userId }).sort({ createdAt: -1 });

  res.json({ success: true, data: docs });
}));

// Delete a document
router.delete('/:id', asyncHandler(async (req, res) => {
  const userId = (req as any).user?.userId || 'default-user-id';
  const doc = await DocumentModel.findOne({ _id: req.params.id, userId });
  
  if (!doc) throw new AppError('Document not found', 404);

  // Delete physical file
  if (fs.existsSync(doc.path)) {
    fs.unlinkSync(doc.path);
  }

  await doc.deleteOne();

  res.json({ success: true, message: 'Deleted' });
}));

export default router;
