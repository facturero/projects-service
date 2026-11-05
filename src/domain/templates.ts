import type { ProjectColor, ProjectView, TaskKind } from './types.js';

/**
 * Plantillas de fábrica: proyectos listos para usar, como las de Asana, pero pensadas para empresas de Ecuador (cierre contable con
 * el calendario del SRI, obra de construcción, contratación con el IESS). Viven en el código y no en la base: son producto, se
 * revisan en la revisión de código y llegan a todas las organizaciones a la vez.
 *
 * Las fechas son relativas al día en que empieza el proyecto (`start` = días desde el inicio, `days` = duración). Las dependencias
 * se declaran por `key` dentro de la misma plantilla.
 */
export type Locale = 'es' | 'en' | 'fr';
export type Localized = Record<Locale, string>;

export interface TemplateTask {
  key?: string;
  title: Localized;
  start?: number;
  days?: number;
  kind?: TaskKind;
  subtasks?: Localized[];
  /** Espera a estas tareas (por `key`). */
  after?: string[];
}

export interface ProjectTemplate {
  code: string;
  icon: string;
  color: ProjectColor;
  defaultView: ProjectView;
  name: Localized;
  description: Localized;
  sections: Array<{ name: Localized; tasks: TemplateTask[] }>;
}

const L = (es: string, en: string, fr: string): Localized => ({ es, en, fr });

export const TEMPLATES: readonly ProjectTemplate[] = [
  {
    code: 'client_onboarding',
    icon: 'mdi-handshake-outline',
    color: 'success',
    defaultView: 'list',
    name: L('Onboarding de cliente', 'Client onboarding', 'Intégration client'),
    description: L(
      'Del contrato firmado al cliente funcionando: datos, accesos, capacitación y seguimiento.',
      'From signed contract to a working client: data, access, training and follow-up.',
      'Du contrat signé au client opérationnel : données, accès, formation et suivi.',
    ),
    sections: [
      {
        name: L('Inicio', 'Kickoff', 'Démarrage'),
        tasks: [
          { key: 'kickoff', title: L('Reunión de arranque con el cliente', 'Kickoff meeting with the client', 'Réunion de lancement avec le client'), start: 0, days: 1 },
          {
            key: 'data',
            title: L('Recibir datos del cliente (RUC, contactos, facturación)', 'Collect client data (tax ID, contacts, billing)', 'Recueillir les données du client (identifiant fiscal, contacts, facturation)'),
            start: 1,
            days: 3,
            after: ['kickoff'],
            subtasks: [L('RUC y razón social', 'Tax ID and legal name', 'Identifiant fiscal et raison sociale'), L('Contactos y correos', 'Contacts and emails', 'Contacts et e-mails')],
          },
        ],
      },
      {
        name: L('Implementación', 'Implementation', 'Mise en place'),
        tasks: [
          { key: 'setup', title: L('Configurar cuenta y accesos', 'Set up account and access', 'Configurer le compte et les accès'), start: 4, days: 3, after: ['data'] },
          { key: 'training', title: L('Capacitación al equipo del cliente', 'Train the client team', "Former l'équipe du client"), start: 7, days: 2, after: ['setup'] },
          { key: 'live', title: L('Cliente en marcha', 'Client live', 'Client opérationnel'), start: 10, kind: 'milestone', after: ['training'] },
        ],
      },
      {
        name: L('Seguimiento', 'Follow-up', 'Suivi'),
        tasks: [{ title: L('Llamada de seguimiento a los 30 días', '30-day follow-up call', 'Appel de suivi à 30 jours'), start: 40, days: 1, after: ['live'] }],
      },
    ],
  },
  {
    code: 'month_end_close',
    icon: 'mdi-calculator-variant-outline',
    color: 'info',
    defaultView: 'list',
    name: L('Cierre contable mensual', 'Month-end close', 'Clôture mensuelle'),
    description: L(
      'Conciliaciones, provisiones, revisión de comprobantes y declaraciones del SRI del mes.',
      'Reconciliations, accruals, document review and the month’s tax filings.',
      'Rapprochements, provisions, revue des pièces et déclarations fiscales du mois.',
    ),
    sections: [
      {
        name: L('Revisión', 'Review', 'Revue'),
        tasks: [
          { key: 'docs', title: L('Revisar comprobantes recibidos y emitidos del mes', 'Review the month’s received and issued documents', 'Revoir les pièces reçues et émises du mois'), start: 0, days: 2 },
          { key: 'bank', title: L('Conciliar bancos', 'Reconcile bank accounts', 'Rapprocher les comptes bancaires'), start: 0, days: 3 },
          { key: 'stock', title: L('Cuadrar inventario con el kardex', 'Reconcile inventory with the stock ledger', "Rapprocher l'inventaire avec le registre des stocks"), start: 1, days: 2 },
        ],
      },
      {
        name: L('Ajustes', 'Adjustments', 'Ajustements'),
        tasks: [
          { key: 'accruals', title: L('Registrar provisiones y depreciaciones', 'Record accruals and depreciation', 'Comptabiliser provisions et amortissements'), start: 3, days: 2, after: ['bank', 'stock'] },
          { key: 'reports', title: L('Revisar balance y estado de resultados', 'Review balance sheet and income statement', 'Revoir bilan et compte de résultat'), start: 5, days: 1, after: ['accruals'] },
        ],
      },
      {
        name: L('Declaraciones', 'Tax filings', 'Déclarations'),
        tasks: [
          {
            key: 'taxes',
            title: L('Preparar formularios 103 y 104 y el ATS', 'Prepare forms 103 and 104 and the ATS', 'Préparer les formulaires 103 et 104 et l’ATS'),
            start: 6,
            days: 2,
            after: ['docs', 'reports'],
          },
          { title: L('Declaraciones presentadas', 'Filings submitted', 'Déclarations déposées'), start: 8, kind: 'milestone', after: ['taxes'] },
        ],
      },
    ],
  },
  {
    code: 'construction_job',
    icon: 'mdi-hard-hat',
    color: 'warning',
    defaultView: 'board',
    name: L('Obra de construcción', 'Construction job', 'Chantier de construction'),
    description: L(
      'Una obra por etapas: permisos, compras de material, avance por hitos y entrega.',
      'A job in stages: permits, material purchasing, milestone progress and handover.',
      'Un chantier par étapes : permis, achats de matériaux, avancement par jalons et livraison.',
    ),
    sections: [
      {
        name: L('Preparación', 'Preparation', 'Préparation'),
        tasks: [
          { key: 'permits', title: L('Permisos municipales', 'Municipal permits', 'Permis municipaux'), start: 0, days: 10 },
          { key: 'budget', title: L('Presupuesto aprobado por el cliente', 'Budget approved by the client', 'Budget approuvé par le client'), start: 0, days: 5, kind: 'approval' },
          { key: 'materials', title: L('Orden de compra de materiales', 'Purchase order for materials', 'Bon de commande des matériaux'), start: 5, days: 5, after: ['budget'] },
        ],
      },
      {
        name: L('Ejecución', 'Execution', 'Exécution'),
        tasks: [
          { key: 'foundation', title: L('Cimentación', 'Foundation', 'Fondations'), start: 10, days: 10, after: ['permits', 'materials'] },
          { key: 'structure', title: L('Estructura', 'Structure', 'Structure'), start: 20, days: 15, after: ['foundation'] },
          { key: 'finishes', title: L('Acabados', 'Finishes', 'Finitions'), start: 35, days: 10, after: ['structure'] },
        ],
      },
      {
        name: L('Entrega', 'Handover', 'Livraison'),
        tasks: [
          { key: 'walkthrough', title: L('Recorrido final con el cliente', 'Final walkthrough with the client', 'Visite finale avec le client'), start: 45, days: 1, after: ['finishes'] },
          { title: L('Obra entregada', 'Job handed over', 'Chantier livré'), start: 46, kind: 'milestone', after: ['walkthrough'] },
        ],
      },
    ],
  },
  {
    code: 'product_launch',
    icon: 'mdi-rocket-launch-outline',
    color: 'primary',
    defaultView: 'board',
    name: L('Lanzamiento de producto', 'Product launch', 'Lancement de produit'),
    description: L(
      'Del producto listo al primer cliente: precio, catálogo, comunicación y ventas.',
      'From a ready product to the first customer: pricing, catalog, communication and sales.',
      'Du produit prêt au premier client : prix, catalogue, communication et ventes.',
    ),
    sections: [
      {
        name: L('Preparar', 'Prepare', 'Préparer'),
        tasks: [
          { key: 'price', title: L('Definir precio y margen', 'Set price and margin', 'Fixer prix et marge'), start: 0, days: 3 },
          { key: 'catalog', title: L('Cargar el producto en el catálogo', 'Add the product to the catalog', 'Ajouter le produit au catalogue'), start: 3, days: 1, after: ['price'] },
        ],
      },
      {
        name: L('Comunicar', 'Communicate', 'Communiquer'),
        tasks: [
          { key: 'materials', title: L('Fotos y textos', 'Photos and copy', 'Photos et textes'), start: 2, days: 5 },
          { key: 'announce', title: L('Anunciar a los clientes', 'Announce to customers', 'Annoncer aux clients'), start: 8, days: 2, after: ['materials', 'catalog'] },
        ],
      },
      {
        name: L('Vender', 'Sell', 'Vendre'),
        tasks: [
          { key: 'launch', title: L('Lanzamiento', 'Launch', 'Lancement'), start: 10, kind: 'milestone', after: ['announce'] },
          { title: L('Revisar ventas de la primera semana', 'Review first-week sales', 'Revoir les ventes de la première semaine'), start: 17, days: 1, after: ['launch'] },
        ],
      },
    ],
  },
  {
    code: 'marketing_campaign',
    icon: 'mdi-bullhorn-outline',
    color: 'error',
    defaultView: 'board',
    name: L('Campaña de marketing', 'Marketing campaign', 'Campagne marketing'),
    description: L(
      'Una campaña de principio a fin: objetivo, piezas, aprobación, publicación y resultados.',
      'A campaign end to end: goal, assets, approval, publishing and results.',
      'Une campagne de bout en bout : objectif, supports, validation, publication et résultats.',
    ),
    sections: [
      {
        name: L('Planificar', 'Plan', 'Planifier'),
        tasks: [
          { key: 'brief', title: L('Objetivo, público y presupuesto', 'Goal, audience and budget', 'Objectif, public et budget'), start: 0, days: 2 },
        ],
      },
      {
        name: L('Producir', 'Produce', 'Produire'),
        tasks: [
          { key: 'assets', title: L('Diseñar piezas', 'Design assets', 'Concevoir les supports'), start: 2, days: 5, after: ['brief'] },
          { key: 'approval', title: L('Aprobar piezas', 'Approve assets', 'Valider les supports'), start: 7, days: 1, kind: 'approval', after: ['assets'] },
        ],
      },
      {
        name: L('Publicar y medir', 'Publish and measure', 'Publier et mesurer'),
        tasks: [
          { key: 'publish', title: L('Publicar la campaña', 'Publish the campaign', 'Publier la campagne'), start: 8, kind: 'milestone', after: ['approval'] },
          { title: L('Informe de resultados', 'Results report', 'Rapport de résultats'), start: 22, days: 2, after: ['publish'] },
        ],
      },
    ],
  },
  {
    code: 'hiring',
    icon: 'mdi-account-plus-outline',
    color: 'secondary',
    defaultView: 'list',
    name: L('Contratación de personal', 'Hiring', 'Recrutement'),
    description: L(
      'Del perfil del puesto al primer día: entrevistas, contrato, aviso de entrada al IESS e inducción.',
      'From job profile to day one: interviews, contract, social security registration and onboarding.',
      'Du profil de poste au premier jour : entretiens, contrat, affiliation à la sécurité sociale et accueil.',
    ),
    sections: [
      {
        name: L('Selección', 'Selection', 'Sélection'),
        tasks: [
          { key: 'profile', title: L('Perfil del puesto', 'Job profile', 'Profil du poste'), start: 0, days: 2 },
          { key: 'interviews', title: L('Entrevistas', 'Interviews', 'Entretiens'), start: 5, days: 7, after: ['profile'] },
          { key: 'offer', title: L('Aprobar la contratación', 'Approve the hire', "Valider l'embauche"), start: 12, days: 1, kind: 'approval', after: ['interviews'] },
        ],
      },
      {
        name: L('Ingreso', 'Onboarding', 'Intégration'),
        tasks: [
          {
            key: 'contract',
            title: L('Contrato y aviso de entrada al IESS', 'Contract and social security registration', 'Contrat et affiliation à la sécurité sociale'),
            start: 13,
            days: 2,
            after: ['offer'],
          },
          {
            key: 'firstday',
            title: L('Primer día', 'First day', 'Premier jour'),
            start: 15,
            kind: 'milestone',
            after: ['contract'],
          },
          { title: L('Inducción y accesos', 'Induction and access', 'Accueil et accès'), start: 15, days: 3, after: ['contract'], subtasks: [L('Correo y usuario del CRM', 'Email and CRM user', 'E-mail et utilisateur du CRM'), L('Equipo de trabajo', 'Work equipment', 'Matériel de travail')] },
        ],
      },
    ],
  },
];

export function findTemplate(code: string): ProjectTemplate | undefined {
  return TEMPLATES.find((t) => t.code === code);
}
