import { MdAutoAwesome, MdCleaningServices, MdMotionPhotosAuto, MdOutlineHealthAndSafety } from 'react-icons/md'
import { TbLeaf } from 'react-icons/tb'
import { FaFan } from 'react-icons/fa'
import { FaGaugeHigh } from 'react-icons/fa6'
import { useTranslation } from 'react-i18next'
import CtrlBtn from '../ctrlBtn/ctrlBtn'
import { Neato, RobotType, type Robot } from '../../types'
import { isGen4D10 } from '../topbar/robotInfo'
import { useCleaningModes } from '../../utils/cleaningModes'

const Gen3Mode = Neato.Gen3.CleaningMode
const Gen3Nav = Neato.Gen3.CleaningNavigationMode
const Gen4Mode = Neato.Gen4.CleaningMode
const Gen4Nav = Neato.Gen4.CleaningNavigationMode

// Toggle buttons for navigation + cleaning mode. The choice is shared via
// useCleaningModes, so every page starting a clean uses the same modes.
// Gen3 rejects Deep together with Eco (invalid_entry), so the two are kept exclusive.
export default function CleaningModeButtons({ robot }: { robot: Robot }) {
    const { t } = useTranslation()
    const { gen3Mode, gen3Navigation, gen4Mode, gen4Navigation, update } = useCleaningModes(robot.serial)

    if (robot.type === RobotType.NeatoGen3) {
        return (
            <>
                {gen3Navigation === Gen3Nav.NORMAL && (<CtrlBtn icon={<MdCleaningServices color='var(--accent)' size={22} />} onClick={() => update({ gen3Navigation: Gen3Nav.EXTRA_CARE })} label={t('modes.normal')} />)}
                {gen3Navigation === Gen3Nav.EXTRA_CARE && (<CtrlBtn icon={<MdOutlineHealthAndSafety color='var(--warn)' size={22} />} onClick={() => update({ gen3Navigation: Gen3Nav.DEEP, gen3Mode: Gen3Mode.NORMAL })} label={t('modes.extraCare')} />)}
                {gen3Navigation === Gen3Nav.DEEP && (<CtrlBtn icon={<MdAutoAwesome color='var(--violet)' size={22} />} onClick={() => update({ gen3Navigation: Gen3Nav.NORMAL })} label={t('modes.deep')} />)}

                {gen3Mode === Gen3Mode.ECO && (<CtrlBtn icon={<TbLeaf size={22} color='lime' />} onClick={() => update({ gen3Mode: Gen3Mode.NORMAL })} label={t('modes.eco')} />)}
                {gen3Mode === Gen3Mode.NORMAL && (<CtrlBtn icon={<FaFan size={22} color='orange' />} onClick={() => update({ gen3Mode: Gen3Mode.ECO, ...(gen3Navigation === Gen3Nav.DEEP && { gen3Navigation: Gen3Nav.NORMAL }) })} label={t('modes.normal')} />)}
            </>
        )
    }

    if (robot.type === RobotType.NeatoGen4) {
        return (
            <>
                {gen4Navigation === Gen4Nav.NORMAL && (<CtrlBtn icon={<MdCleaningServices color='var(--accent)' size={22} />} onClick={() => update({ gen4Navigation: Gen4Nav.GENTLE })} label={t('modes.normal')} />)}
                {gen4Navigation === Gen4Nav.GENTLE && (<CtrlBtn icon={<MdOutlineHealthAndSafety color='var(--warn)' size={22} />} onClick={() => update({ gen4Navigation: Gen4Nav.NORMAL })} label={t('modes.gentle')} />)}

                {/* TODO: verify hardware in other gen4 robots, read more at the "isGen4D10" func */}
                {gen4Mode === Gen4Mode.ECO && (<CtrlBtn icon={<TbLeaf size={22} color='lime' />} onClick={() => update({ gen4Mode: Gen4Mode.TURBO })} label={t('modes.eco')} />)}
                {gen4Mode === Gen4Mode.TURBO && (<CtrlBtn icon={<FaFan size={22} color='orange' />} onClick={() => update({ gen4Mode: isGen4D10(robot) ? Gen4Mode.MAX : Gen4Mode.ECO })} label={t('modes.turbo')} />)}
                {isGen4D10(robot) && (
                    <>
                        {gen4Mode === Gen4Mode.MAX && (<CtrlBtn icon={<FaGaugeHigh size={22} color='orange' />} onClick={() => update({ gen4Mode: Gen4Mode.AUTO })} label={t('modes.max')} />)}
                        {gen4Mode === Gen4Mode.AUTO && (<CtrlBtn icon={<MdMotionPhotosAuto size={22} color='purple' />} onClick={() => update({ gen4Mode: Gen4Mode.ECO })} label={t('modes.auto')} />)}
                    </>
                )}
            </>
        )
    }

    return null
}
